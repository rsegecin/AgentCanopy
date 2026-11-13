import type { OperationId, ReviewEntry, Settings } from '../../../shared';
import type { LogRecord } from '../../contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** However the settings read, the newest operations are always kept. */
export const MINIMUM_KEPT_OPERATIONS = 5;

/**
 * How many records at the start of the log can go. The log is cut at an operation: everything from
 * the earliest of these onward stays.
 * - the `retentionOperations`-th newest operation;
 * - the oldest operation younger than `retentionDays`;
 * - the earliest operation that a review entry (pending or accepted, still shown) is made of;
 * - the fifth newest operation;
 * - the last agent turn: nothing after it is dropped.
 */
export function recordsToDrop(
  records: readonly LogRecord[],
  entries: readonly ReviewEntry[],
  settings: Pick<Settings, 'retentionOperations' | 'retentionDays'>,
  now: number,
): number {
  // Only operations that changed something count; the others (a restore's safety record) go along.
  const operations: { index: number; id: OperationId; at: number }[] = [];
  let lastTurn = -1;
  records.forEach((record, index) => {
    if (record.type !== 'operation') return;
    if (record.kind === 'agent-turn') lastTurn = index;
    if (record.changes.length > 0) operations.push({ index, id: record.id, at: record.at });
  });
  if (operations.length === 0) return 0;

  const newest = (count: number): number => {
    const from = operations.length - count;
    return from <= 0 ? 0 : (operations[from] as { index: number }).index;
  };
  const youngerThan = now - settings.retentionDays * DAY_MS;
  const young = operations.find((op) => op.at > youngerThan);

  const needed = new Set<OperationId>(entries.flatMap((entry) => entry.operationIds));
  const neededFrom = operations.find((op) => needed.has(op.id));

  let keepFrom = Math.min(
    newest(settings.retentionOperations),
    young === undefined ? records.length : young.index,
    neededFrom === undefined ? records.length : neededFrom.index,
    newest(MINIMUM_KEPT_OPERATIONS),
    // What came after the last agent turn tells the next prompt what was reverted: never drop it.
    lastTurn < 0 ? records.length : lastTurn,
  );
  // A restore that is kept must find the operation it went back to: the fold needs it to know which
  // operations the restore undid. Follow such references until nothing more is pulled in.
  const indexOf = new Map<OperationId, number>(operations.map((op) => [op.id, op.index]));
  for (let again = true; again;) {
    again = false;
    for (let i = keepFrom; i < records.length; i += 1) {
      const record = records[i] as LogRecord;
      if (record.type !== 'operation' || record.kind !== 'restore') continue;
      const target = record.restoredTo === undefined ? undefined : indexOf.get(record.restoredTo);
      if (target !== undefined && target < keepFrom) {
        keepFrom = target;
        again = true;
      }
    }
  }
  return keepFrom;
}
