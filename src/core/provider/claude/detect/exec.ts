import { execFile } from 'node:child_process';

export type ExecFn = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string }>;

const MAX_OUTPUT_BYTES = 1024 * 1024;
export const EXEC_TIMEOUT_MS = 10_000;

/** Runs a command without a shell and with stdin closed. Never rejects. */
export const defaultExec: ExecFn = (command, args, opts) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        command,
        args,
        {
          timeout: opts.timeoutMs,
          // A probe that ignores SIGTERM must not be left running after its timeout.
          killSignal: 'SIGKILL',
          env: opts.env,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof code === 'number') {
            resolve({ exitCode: code, stdout, stderr });
            return;
          }
          const timedOut = 'killed' in err && err.killed === true;
          resolve({
            exitCode: null,
            stdout,
            stderr,
            error: timedOut ? 'timed out' : typeof code === 'string' ? code : err.message,
          });
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end();
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : 'exec failed',
      });
    }
  });
