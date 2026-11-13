import { spawn, type ChildProcess } from 'node:child_process';
import { redact, tail } from '../../../util';
import { LineFramer } from './framer';
import type { ClaudeLaunch } from './launch';

export interface RunClaudeOptions {
  launch: ClaudeLaunch;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  /** How long SIGINT gets before cancel escalates to SIGTERM. */
  interruptGraceMs?: number;
  /** How long SIGTERM gets before cancel escalates to SIGKILL on the process group. */
  terminateGraceMs?: number;
  /** Longest accepted stdout line in bytes. Longer lines are dropped and counted. */
  maxLineBytes?: number;
}

export interface ClaudeExit {
  exitCode: number | null;
  signal: string | null;
  /** Last part of stderr, redacted. */
  stderrTail: string;
  /** Set when the process could not be started. */
  spawnError?: string;
}

export interface ClaudeProcess {
  readonly pid: number | undefined;
  /** Stdout lines in order. Single consumer. Ends after the process closed. Never throws. */
  readonly lines: AsyncIterable<string>;
  droppedLines(): number;
  /** SIGINT, then SIGTERM, then SIGKILL on the group, each after a grace period. Idempotent. */
  cancel(): Promise<void>;
  /** SIGKILL on the whole process group at once. */
  kill(): void;
  readonly done: Promise<ClaudeExit>;
}

const STDERR_BYTES = 16 * 1024;
const STDERR_REPORT_CHARS = 4000;
/** After the process exits, how long to wait for its pipes to close before giving up on them. */
const PIPE_CLOSE_WAIT_MS = 1000;
const IS_WINDOWS = process.platform === 'win32';

class LineQueue implements AsyncIterableIterator<string> {
  private readonly items: string[] = [];
  private waiter: ((result: IteratorResult<string>) => void) | undefined;
  private ended = false;
  private abandoned = false;

  push(line: string): void {
    if (this.ended || this.abandoned) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: line, done: false });
    } else {
      this.items.push(line);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiter && this.items.length === 0) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<string>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended || this.abandoned) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<string>> {
    this.abandoned = true;
    this.items.length = 0;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined, done: true });
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    return this;
  }
}

function taskkill(pid: number): void {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => undefined);
  } catch {
    // Nothing more can be done.
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process is already gone.
  }
}

export function runClaude(options: RunClaudeOptions): ClaudeProcess {
  const interruptGraceMs = options.interruptGraceMs ?? 5000;
  const terminateGraceMs = options.terminateGraceMs ?? 3000;
  const framer = new LineFramer(options.maxLineBytes);
  const queue = new LineQueue();

  let stderrBuf = Buffer.alloc(0);
  let exited = false;
  let settled = false;
  let spawnError: string | undefined;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let resolveDone!: (exit: ClaudeExit) => void;
  const done = new Promise<ClaudeExit>((resolve) => {
    resolveDone = resolve;
  });

  let child: ChildProcess | undefined;
  try {
    child = spawn(options.launch.command, [...options.launch.prefixArgs, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }

  const settle = (): void => {
    if (settled) return;
    settled = true;
    for (const line of framer.flush()) queue.push(line);
    queue.end();
    const stderrTail = tail(redact(stderrBuf.toString('utf8')), STDERR_REPORT_CHARS);
    const exit: ClaudeExit = { exitCode, signal: exitSignal, stderrTail };
    if (spawnError !== undefined) exit.spawnError = redact(spawnError);
    resolveDone(exit);
  };

  const pid = child?.pid;

  if (child === undefined) {
    exited = true;
    resolveExited();
    settle();
  } else {
    const proc = child;
    let closeTimer: NodeJS.Timeout | undefined;

    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of framer.push(chunk)) queue.push(line);
    });
    proc.stdout?.on('error', () => undefined);
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = Buffer.concat([stderrBuf, chunk]);
      if (stderrBuf.length > STDERR_BYTES) {
        stderrBuf = stderrBuf.subarray(stderrBuf.length - STDERR_BYTES);
      }
    });
    proc.stderr?.on('error', () => undefined);
    proc.stdin?.on('error', () => undefined); // EPIPE when the child exits before reading.
    proc.stdin?.end(options.stdin);

    proc.on('error', (error) => {
      if (proc.pid === undefined) {
        spawnError = error.message;
        exited = true;
        resolveExited();
        settle();
      }
    });
    proc.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolveExited();
      // A grandchild that inherited the pipes can keep them open; do not wait for it forever.
      closeTimer = setTimeout(() => {
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        settle();
      }, PIPE_CLOSE_WAIT_MS);
    });
    proc.on('close', (code, signal) => {
      if (closeTimer) clearTimeout(closeTimer);
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolveExited();
      settle();
    });
  }

  const hardKill = (): void => {
    if (pid === undefined || exited) return;
    if (IS_WINDOWS) taskkill(pid);
    else trySignal(-pid, 'SIGKILL');
  };

  const waitExit = async (ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([exitedPromise, timeout]);
    if (timer) clearTimeout(timer);
    return exited;
  };

  let cancelPromise: Promise<void> | undefined;
  const runCancel = async (): Promise<void> => {
    if (pid === undefined || exited) {
      await done;
      return;
    }
    if (IS_WINDOWS) {
      taskkill(pid);
      await done;
      return;
    }
    trySignal(pid, 'SIGINT');
    if (!(await waitExit(interruptGraceMs))) {
      trySignal(pid, 'SIGTERM');
      if (!(await waitExit(terminateGraceMs))) {
        hardKill();
        await exitedPromise;
      }
    }
    await done;
  };

  return {
    pid,
    lines: queue,
    droppedLines: () => framer.droppedLines,
    cancel(): Promise<void> {
      cancelPromise ??= runCancel();
      return cancelPromise;
    },
    kill: hardKill,
    done,
  };
}
