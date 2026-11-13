import { afterEach, describe, expect, it } from 'vitest';
import { fakeClaude, initEvent, type FakeClaude } from '../../../../../test/fake-cli';
import { isAlive, processStartedAt, stopOrphan } from './orphans';
import { runClaude, type ClaudeProcess } from './runner';

const posix = process.platform !== 'win32';
let fakes: FakeClaude[] = [];
let procs: ClaudeProcess[] = [];

afterEach(async () => {
  for (const proc of procs) proc.kill();
  await Promise.all(procs.map((p) => p.done));
  await Promise.all(fakes.map((f) => f.dispose()));
  fakes = [];
  procs = [];
});

async function hanging(scenario: object): Promise<ClaudeProcess> {
  const fake = await fakeClaude({ ...scenario, steps: [initEvent(), { hang: true }] });
  fakes.push(fake);
  const proc = runClaude({
    launch: fake.launch,
    args: [],
    cwd: process.cwd(),
    env: fake.env,
    stdin: '',
  });
  procs.push(proc);
  await proc.lines[Symbol.asyncIterator]().next(); // signal handlers are installed
  return proc;
}

describe('isAlive', () => {
  it('is true for this process and false for an unused pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe.skipIf(!posix)('processStartedAt', () => {
  it('returns a start time for a live process and undefined for a missing one', async () => {
    expect(await processStartedAt(process.pid)).toMatch(/\d{4}/);
    expect(await processStartedAt(2 ** 22 + 12345)).toBeUndefined();
  });
});

describe.skipIf(!posix)('stopOrphan', () => {
  it('stops a hanging process with SIGTERM', async () => {
    const proc = await hanging({});
    const pid = proc.pid as number;
    expect(isAlive(pid)).toBe(true);
    expect(await stopOrphan(pid)).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect((await proc.done).exitCode).toBe(143);
  });

  it('falls back to SIGKILL when SIGTERM is ignored', async () => {
    const proc = await hanging({ onSigterm: 'ignore' });
    const pid = proc.pid as number;
    expect(await stopOrphan(pid, 300)).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect((await proc.done).signal).toBe('SIGKILL');
  });

  it('returns true for a process that is not there', async () => {
    expect(await stopOrphan(2 ** 22 + 12345)).toBe(true);
  });
});
