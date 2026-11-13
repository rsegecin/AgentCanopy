/** Small seams that keep core logic testable without VS Code. */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** What the workspace engine needs to know about open editors. Paths are absolute. */
export interface EditorPort {
  /** Files with unsaved changes. */
  dirtyFiles(): string[];
  isDirty(absolutePath: string): boolean;
  /** Called when the user (not an extension write) saves a file. Returns an unsubscribe function. */
  onDidSave(listener: (absolutePath: string) => void): () => void;
}

export const noEditor: EditorPort = {
  dirtyFiles: () => [],
  isDirty: () => false,
  onDidSave: () => () => undefined,
};
