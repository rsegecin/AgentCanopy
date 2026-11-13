import type { ForkInfo } from '../../../shared';

/** What the user is told about how exact a branch is. */
export function forkStatusText(fork: ForkInfo): string {
  switch (fork.exactness) {
    case 'pending':
      return 'Its context is decided when you send the first message.';
    case 'exact':
      return 'Exact copy of the conversation up to that point.';
    case 'reconstructed':
      return fork.lost.length > 0
        ? `Context rebuilt from the visible messages. Not carried over: ${fork.lost.join(', ')}.`
        : 'Context rebuilt from the visible messages.';
  }
}

export const FORK_ICON: Record<ForkInfo['exactness'], string> = {
  pending: 'info',
  exact: 'check',
  reconstructed: 'warning',
};
