import * as vscode from 'vscode';
import type { Logger } from '../../core/contracts';
import { redact } from '../../core/util';

export interface HostLogger extends Logger {
  /** Brings the AgentCanopy output channel to the front. */
  show(): void;
  dispose(): void;
}

/** Turns data into one redacted line. Every string value, at any depth, passes through `redact`. */
export function formatData(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value === 'string') return redact(value);
      if (value instanceof Error) return { name: value.name, message: redact(value.message) };
      if (typeof value === 'bigint') return value.toString();
      return value;
    });
  } catch {
    return '[unserializable data]';
  }
}

/** A Logger over a VS Code log output channel. Nothing reaches the channel without redaction. */
export function createLogger(): HostLogger {
  const channel = vscode.window.createOutputChannel('AgentCanopy', { log: true });
  const write =
    (method: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, data?: Record<string, unknown>): void => {
      const line = data === undefined ? redact(message) : `${redact(message)} ${formatData(data)}`;
      channel[method](line);
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    show: () => {
      channel.show(true);
    },
    dispose: () => {
      channel.dispose();
    },
  };
}
