import type { TurnPolicy } from '../../contracts';
import { silentLogger, type Logger } from '../../contracts';
import { decideReadOnly } from './decide';
import { inspectEvent, newGuardState, type GuardState } from './guard';

/**
 * The policy of the read-only modes. Ask and Plan run under it; Agent mode has its own policy
 * (src/core/policy/agent), and `createModePolicy` picks one per turn.
 *
 * The guard keeps state for the turn it watches, so every conversation gets its own, keyed on the
 * conversation id. A conversation runs one turn at a time, so a turn's state is dropped when its
 * `result` event has been seen, and a `session` event (the first event of a turn) always starts a
 * fresh one. A turn that is killed before its result leaves one small entry until the next turn.
 */
export function createReadOnlyPolicy(options: { logger?: Logger } = {}): TurnPolicy {
  const logger = options.logger ?? silentLogger;
  const guards = new Map<string, GuardState>();

  return {
    profile({ mode, settings, conversation }) {
      switch (mode) {
        case 'ask':
          return { kind: 'read-only', webTools: settings.askWebTools, planTool: false };
        case 'plan':
          return {
            kind: 'read-only',
            webTools: settings.askWebTools,
            planTool: !conversation.planLocked,
          };
        case 'agent':
          return { unavailable: 'Agent mode is not available yet.' };
      }
    },

    decide(request, context) {
      return decideReadOnly(request, context, logger);
    },

    inspect(event, context) {
      const id = context.conversation.id;
      let state = guards.get(id);
      if (state === undefined || event.type === 'session') {
        state = newGuardState();
        guards.set(id, state);
      }
      const finding = inspectEvent(state, event, context);
      if (event.type === 'result') guards.delete(id);
      return finding;
    },
  };
}
