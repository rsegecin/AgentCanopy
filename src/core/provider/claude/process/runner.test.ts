import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeClaude,
  initEvent,
  resultEvent,
  textTurn,
  type FakeClaude,
  type FakeClaudeRecord,
} from '../../../../../test/fake-cli';
import { isAlive } from './orphans';
import { runClaude, type ClaudeProcess, type RunClaudeOptions } from './runner';

const SESSION = '11111111-1111-4111-8111-111111111111';
const posix = process.platform !== 'win32';

let cwd: string;
let fakes: FakeClaude[] = [];
let procs: ClaudeProcess[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'runner-cwd-'));
});

afterEach(async () => {
  for (const proc of procs) proc.kill();
  await Promise.all(procs.map((p) => p.done));
  for (const proc of procs) {
    if (proc.pid !== undefined) expect(isAlive(proc.pid)).toBe(false);
  }
  await Promise.all(fakes.map((f) => f.dispose()));
  await rm(cwd, { recursive: true, force: true });
  fakes = [];
  procs = [];
});

async function start(
  scenario: object,
  options: { record?: boolean; extraEnv?: NodeJS.ProcessEnv } & Partial<RunClaudeOptions> = {},
): Promise<{ proc: ClaudeProcess; fake: FakeClaude }> {
  const fake = await fakeClaude(scenario, { record: options.record });
  fakes.push(fake);
  const { record: _record, extraEnv, ...rest } = options;
  void _record;
  const proc = runClaude({
    launch: fake.launch,
    args: ['--session-id', SESSION],
    cwd,
    env: { ...fake.env, ...extraEnv },
    stdin: 'hello',
    ...rest,
  });
  procs.push(proc);
  return { proc, fake };
}

async function collect(proc: ClaudeProcess): Promise<string[]> {
  const out: string[] = [];
  for await (const line of proc.lines) out.push(line);
  return out;
}

describe('runClaude', () => {
  it('yields the lines of a normal turn in order and exits 0', async () => {
    const { proc } = await start({
      steps: [...textTurn('pong'), ...resultEvent('pong'), { exit: 0 }],
    });
    expect(proc.pid).toBeTypeOf('number');
    const lines = await collect(proc);
    const types = lines.map((l) => {
      const e = JSON.parse(l) as { type: string; subtype?: string; state?: string };
      return `${e.type}${e.subtype ? `/${e.subtype}` : ''}`;
    });
    expect(types[0]).toBe('system/session_state_changed');
    expect(types[1]).toBe('system/init');
    expect(types.at(-2)).toBe('result/success');
    expect(types.at(-1)).toBe('system/session_state_changed');
    const init = JSON.parse(lines[1] ?? '') as { session_id: string; cwd: string };
    expect(init.session_id).toBe(SESSION);
    const exit = await proc.done;
    expect(exit).toMatchObject({ exitCode: 0, signal: null });
    expect(exit.spawnError).toBeUndefined();
    expect(proc.droppedLines()).toBe(0);
  });

  it('delivers stdin, args and env to the child', async () => {
    const prompt = 'line one\nline two with ünïcode and "quotes"\n'.repeat(2000);
    const { proc, fake } = await start(
      { steps: [{ emit: { type: 'x' } }], recordEnv: ['ANTHROPIC_MARKER'] },
      { record: true, stdin: prompt, extraEnv: { ANTHROPIC_MARKER: 'kept' } },
    );
    await collect(proc);
    await proc.done;
    const record = JSON.parse(await readFile(fake.recordPath ?? '', 'utf8')) as FakeClaudeRecord;
    expect(record.stdin).toBe(prompt);
    expect(record.argv).toEqual(['--session-id', SESSION]);
    expect(record.env).toEqual({ ANTHROPIC_MARKER: 'kept' });
    expect(await realpath(record.cwd)).toBe(await realpath(cwd));
  });

  it('captures and redacts the stderr tail', async () => {
    const { proc } = await start({
      steps: [
        { stderr: 'x'.repeat(20000) },
        { stderr: '\nauth failed with Bearer abcdefghijklmnop for user@example.com\n' },
        { emit: { type: 'x' } },
        { exit: 3 },
      ],
    });
    await collect(proc);
    const exit = await proc.done;
    expect(exit.exitCode).toBe(3);
    expect(exit.stderrTail).toContain('auth failed');
    expect(exit.stderrTail).toContain('[redacted]');
    expect(exit.stderrTail).not.toContain('abcdefghijklmnop');
    expect(exit.stderrTail).not.toContain('user@example.com');
    expect(exit.stderrTail.length).toBeLessThanOrEqual(4000);
  });

  it('ends the lines when the process crashes mid-line and reports the exit code', async () => {
    const { proc } = await start({
      steps: [{ emit: { type: 'first' } }, { emitRaw: '{"type":"par' }, { crash: true }],
    });
    const lines = await collect(proc);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ type: 'first' });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('{"type":"par');
    expect(await proc.done).toMatchObject({ exitCode: 137 });
  });

  it('passes a 5 MB line', async () => {
    const { proc } = await start({
      steps: [{ emit: { type: 'a' } }, { emitBig: 5 * 1024 * 1024 }, { emit: { type: 'b' } }],
    });
    const lines = await collect(proc);
    expect(lines).toHaveLength(3);
    expect(Buffer.byteLength(lines[1] ?? '')).toBe(5 * 1024 * 1024);
    expect(proc.droppedLines()).toBe(0);
    await proc.done;
  });

  it('drops and counts a line over the cap', async () => {
    const { proc } = await start(
      { steps: [{ emit: { type: 'a' } }, { emitBig: 100_000 }, { emit: { type: 'b' } }] },
      { maxLineBytes: 1000 },
    );
    const lines = await collect(proc);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['a', 'b']);
    expect(proc.droppedLines()).toBe(1);
    await proc.done;
  });

  it('drains stdout even when nobody reads the lines', async () => {
    const { proc } = await start({
      steps: [{ emitBig: 3 * 1024 * 1024 }, { emit: { type: 'z' } }],
    });
    const exit = await proc.done;
    expect(exit.exitCode).toBe(0);
    expect(await collect(proc)).toHaveLength(2);
  });

  describe.skipIf(!posix)('cancel and kill', () => {
    it('cancel with onSigint "result" yields the result line and exits 0', async () => {
      const { proc } = await start({
        onSigint: 'result',
        steps: [initEvent(), { hang: true }],
      });
      const iterator = proc.lines[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false); // handlers are installed by now
      await proc.cancel();
      const rest: string[] = [];
      for (let r = await iterator.next(); !r.done; r = await iterator.next()) rest.push(r.value);
      expect(rest).toHaveLength(1);
      expect(JSON.parse(rest[0] ?? '')).toMatchObject({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
      });
      expect(await proc.done).toMatchObject({ exitCode: 0, signal: null });
    });

    it('cancel escalates to SIGTERM when SIGINT is ignored', async () => {
      const { proc } = await start(
        { onSigint: 'ignore', steps: [initEvent(), { hang: true }] },
        { interruptGraceMs: 200, terminateGraceMs: 2000 },
      );
      await firstLine(proc);
      await proc.cancel();
      expect(await proc.done).toMatchObject({ exitCode: 143 });
    });

    it('cancel ends by SIGKILL when SIGINT and SIGTERM are both ignored', async () => {
      const { proc } = await start(
        { onSigint: 'ignore', onSigterm: 'ignore', steps: [initEvent(), { hang: true }] },
        { interruptGraceMs: 200, terminateGraceMs: 200 },
      );
      await firstLine(proc);
      const started = Date.now();
      await proc.cancel();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(380);
      expect(elapsed).toBeLessThan(4000);
      expect(await proc.done).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
    });

    it('cancel twice is safe and returns the same result', async () => {
      const { proc } = await start({ onSigint: 'exit', steps: [initEvent(), { hang: true }] });
      await firstLine(proc);
      const [a, b] = await Promise.all([proc.cancel(), proc.cancel()]);
      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
      await proc.cancel();
      expect((await proc.done).exitCode).toBe(130);
    });

    it('cancel after exit resolves at once', async () => {
      const { proc } = await start({ steps: [{ emit: { type: 'a' } }] });
      await proc.done;
      await proc.cancel();
    });

    it('kill ends a hanging process that ignores signals', async () => {
      const { proc } = await start({
        onSigint: 'ignore',
        onSigterm: 'ignore',
        steps: [initEvent(), { hang: true }],
      });
      await firstLine(proc);
      proc.kill();
      expect(await proc.done).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
    });
  });

  it('resolves done with spawnError for a missing command, without throwing', async () => {
    const proc = runClaude({
      launch: { command: join(cwd, 'no-such-binary'), prefixArgs: [] },
      args: [],
      cwd,
      env: process.env,
      stdin: 'x',
    });
    procs.push(proc);
    expect(await collect(proc)).toEqual([]);
    const exit = await proc.done;
    expect(exit.spawnError).toMatch(/ENOENT/);
    expect(proc.pid).toBeUndefined();
    await proc.cancel();
    proc.kill();
  });

  it('resolves done with spawnError for a missing working directory', async () => {
    const fake = await fakeClaude({ steps: [] });
    fakes.push(fake);
    const proc = runClaude({
      launch: fake.launch,
      args: [],
      cwd: join(cwd, 'missing'),
      env: fake.env,
      stdin: '',
    });
    procs.push(proc);
    expect(await collect(proc)).toEqual([]);
    expect((await proc.done).spawnError).toBeDefined();
  });

  it('ignores EPIPE when the child exits without reading stdin', async () => {
    const proc = runClaude({
      launch: { command: process.execPath, prefixArgs: ['-e', 'process.exit(5)'] },
      args: [],
      cwd,
      env: process.env,
      stdin: 'x'.repeat(5 * 1024 * 1024),
    });
    procs.push(proc);
    expect(await collect(proc)).toEqual([]);
    expect((await proc.done).exitCode).toBe(5);
  });
});

async function firstLine(proc: ClaudeProcess): Promise<void> {
  const r = await proc.lines[Symbol.asyncIterator]().next();
  expect(r.done).toBe(false);
}

async function realpath(path: string): Promise<string> {
  const { realpath: rp } = await import('node:fs/promises');
  return rp(path);
}
