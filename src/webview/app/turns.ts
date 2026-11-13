import type { Turn } from '../../shared';

/** True while the last turn is starting or running. */
export function isTurnRunning(turns: readonly Turn[] | undefined): boolean {
  const last = turns?.[turns.length - 1];
  return last?.status === 'running' || last?.status === 'preparing';
}
