import type { AgentEvent, ModelInfo, ProviderStatus } from '../../../shared';
import type { AgentProvider, Logger, TurnExit, TurnHandle, TurnRequest } from '../../contracts';
import { silentLogger } from '../../contracts';
import { AsyncQueue, redact } from '../../util';
import { claudeModels, detectClaude, type ExecFn } from './detect';
import { createClaudeEventMapper } from './events';
import {
  buildChildEnv,
  prepareInvocation,
  runClaude,
  type ClaudeLaunch,
  type ClaudeProcess,
} from './process';

export interface ClaudeProviderOptions {
  /** Path to the executable from the settings. Empty means "search". Read at every detection. */
  claudePath(): string;
  /** The environment the extension host runs in. */
  env?: () => NodeJS.ProcessEnv;
  /** Run this command instead of locating the executable (tests). */
  launchOverride?: ClaudeLaunch;
  exec?: ExecFn;
  logger?: Logger;
  interruptGraceMs?: number;
  terminateGraceMs?: number;
}

/**
 * Drives the user's installed Claude Code CLI: one process per turn, structured output only.
 * It never reads, stores or forwards credentials; signing in happens in Claude Code itself.
 */
export function createClaudeProvider(options: ClaudeProviderOptions): AgentProvider {
  const logger = options.logger ?? silentLogger;
  const baseEnv = (): NodeJS.ProcessEnv => (options.env ? options.env() : process.env);
  let launch: ClaudeLaunch | undefined;

  async function detect(signal?: AbortSignal): Promise<ProviderStatus> {
    const detectOptions: Parameters<typeof detectClaude>[0] = {
      claudePath: options.claudePath(),
      env: baseEnv(),
    };
    if (options.launchOverride) detectOptions.launchOverride = options.launchOverride;
    if (options.exec) detectOptions.exec = options.exec;
    if (signal) detectOptions.signal = signal;
    const result = await detectClaude(detectOptions);
    launch = result.launch;
    logger.info('provider detected', {
      installed: result.status.installed,
      version: result.status.version,
      auth: result.status.auth,
    });
    return result.status;
  }

  function startTurn(request: TurnRequest): TurnHandle {
    const events = new AsyncQueue<AgentEvent>();
    const mapper = createClaudeEventMapper({ resuming: request.session.kind !== 'new' });
    let child: ClaudeProcess | undefined;
    let resolveStarted!: (pid: number | undefined) => void;
    const started = new Promise<number | undefined>((resolve) => {
      resolveStarted = resolve;
    });
    let cancelRequested = false;
    let killRequested = false;
    let sawResult = false;

    const emit = (batch: AgentEvent[]): void => {
      for (const event of batch) {
        if (event.type === 'result') sawResult = true;
        events.push(event);
      }
    };

    const fail = (message: string): TurnExit => {
      emit(
        mapper.finish({
          exitCode: null,
          signal: null,
          stderrTail: '',
          spawnError: message,
          cancelled: false,
          droppedLines: 0,
        }),
      );
      return { exitCode: null, signal: null, sawResult: false, stderrTail: '' };
    };

    const run = async (): Promise<TurnExit> => {
      if (!launch) await detect();
      if (!launch) return fail('Claude Code is not installed or is too old.');
      if (cancelRequested || killRequested) {
        emit(
          mapper.finish({
            exitCode: null,
            signal: null,
            stderrTail: '',
            cancelled: true,
            droppedLines: 0,
          }),
        );
        return { exitCode: null, signal: null, sawResult: false, stderrTail: '' };
      }
      let prepared: Awaited<ReturnType<typeof prepareInvocation>>;
      try {
        prepared = await prepareInvocation(request);
      } catch (error) {
        return fail(redact(error instanceof Error ? error.message : String(error)));
      }
      const runOptions: Parameters<typeof runClaude>[0] = {
        launch,
        args: prepared.args,
        cwd: request.cwd,
        env: buildChildEnv(baseEnv(), prepared.readOnly),
        stdin: prepared.stdin,
      };
      if (options.interruptGraceMs !== undefined)
        runOptions.interruptGraceMs = options.interruptGraceMs;
      if (options.terminateGraceMs !== undefined)
        runOptions.terminateGraceMs = options.terminateGraceMs;
      child = runClaude(runOptions);
      resolveStarted(child.pid);
      logger.info('turn process started', { pid: child.pid, mode: request.mode });
      // A cancel or kill may have arrived while the files were being written.
      if (killRequested) child.kill();
      else if (cancelRequested) void child.cancel();

      for await (const line of child.lines) emit(mapper.push(line));
      const exit = await child.done;
      const finishInput: Parameters<typeof mapper.finish>[0] = {
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrTail: exit.stderrTail,
        cancelled: cancelRequested || killRequested,
        droppedLines: child.droppedLines(),
      };
      if (exit.spawnError !== undefined) finishInput.spawnError = exit.spawnError;
      const hadResult = sawResult;
      emit(mapper.finish(finishInput));
      logger.info('turn process ended', {
        exitCode: exit.exitCode,
        signal: exit.signal,
        sawResult: hadResult,
      });
      return {
        exitCode: exit.exitCode,
        signal: exit.signal,
        sawResult: hadResult,
        stderrTail: exit.stderrTail,
      };
    };

    const done = run()
      .catch((error: unknown): TurnExit => {
        logger.error('turn failed unexpectedly', { error: redact(String(error)) });
        return fail('AgentCanopy hit an unexpected error while running Claude Code.');
      })
      .finally(() => {
        resolveStarted(undefined);
        events.end();
      });

    return {
      get pid() {
        return child?.pid;
      },
      started,
      events,
      async cancel(): Promise<void> {
        cancelRequested = true;
        if (child) await child.cancel();
        await done;
      },
      kill(): void {
        killRequested = true;
        child?.kill();
      },
      done,
    };
  }

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    detect,
    listModels: (custom: readonly string[]): ModelInfo[] => claudeModels(custom),
    // Only a directly found executable is offered: a test launch with prefix arguments is not a
    // command a person would type.
    signInCommand: () =>
      launch && launch.prefixArgs.length === 0
        ? { executable: launch.command, args: ['auth', 'login'] }
        : undefined,
    startTurn,
  };
}
