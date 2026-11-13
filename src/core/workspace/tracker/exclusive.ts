import { AbortError } from '../store';

/**
 * Runs one piece of work at a time, in the order requested. Not re-entrant: work that already holds
 * the queue must call the unlocked methods of the folder, because a call made from inside the work
 * (or from a timer or listener created by it) queues behind it like any other. A waiter can be
 * cancelled with a signal until its turn comes.
 */
export class ExclusiveQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }
      const previous = this.tail;
      let release: () => void = () => undefined;
      this.tail = previous.then(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      let cancelled = false;
      const onAbort = (): void => {
        cancelled = true;
        reject(new AbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void previous.then(() => {
        signal?.removeEventListener('abort', onAbort);
        if (cancelled) {
          release();
          return;
        }
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => release());
      });
    });
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}
