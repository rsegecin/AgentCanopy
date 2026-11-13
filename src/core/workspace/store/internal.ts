/** Small helpers shared by the modules of the workspace store. Not part of the public API. */

/** Thrown when an operation is cancelled through its `AbortSignal`. */
export class AbortError extends Error {
  override name = 'AbortError';
  constructor(message = 'The operation was aborted') {
    super(message);
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** True for errors that mean "the path is not there (any more)". */
export function isVanished(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Limits how many asynchronous operations run at once. */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    }
  }
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
