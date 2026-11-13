import { execFile } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/** Whether a process with this id exists (signal 0 checks without sending anything). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The start time of a process as `ps` prints it, used with the pid to tell a recorded process from
 * an unrelated one that reused the pid. Undefined on Windows or when it cannot be read.
 */
export function processStartedAt(pid: number): Promise<string | undefined> {
  if (IS_WINDOWS) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 }, (error, stdout) => {
      const text = error ? '' : stdout.trim();
      resolve(text.length > 0 ? text : undefined);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stops a CLI left over from an earlier session. SIGTERM goes to the process first so the CLI
 * stops its own commands; if it is still there after the grace period, its process group is killed.
 * Returns whether the process is gone.
 */
export async function stopOrphan(pid: number, graceMs = 3000): Promise<boolean> {
  if (!isAlive(pid)) return true;
  if (IS_WINDOWS) {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () =>
        resolve(),
      );
    });
    return !isAlive(pid);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone, or not ours to signal; the check below decides.
  }
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await delay(50);
  if (!isAlive(pid)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone, or not permitted.
    }
  }
  const killDeadline = Date.now() + 2000;
  while (isAlive(pid) && Date.now() < killDeadline) await delay(25);
  return !isAlive(pid);
}
