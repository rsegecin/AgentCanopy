import type { RejectResult } from '../../core/contracts';

export const UNSAVED_MESSAGE = 'Save or discard your unsaved changes in this file first.';
export const MAY_HOLD_OWN_WORK_MESSAGE =
  'This file may include your own work. Use Reject on the whole file to choose what happens.';
export const CHANGED_SINCE_MESSAGE =
  'This part of the file changed after the agent edited it, so it was not restored.';

/** What to tell the user when a hunk action did not happen. A finished action says nothing. */
export function hunkProblemMessage(result: RejectResult): string | undefined {
  if (result.status === 'done') return undefined;
  if (result.status === 'refused') return result.message;
  switch (result.reason) {
    case 'unsaved-editor':
      return UNSAVED_MESSAGE;
    case 'uncertain-source':
      return MAY_HOLD_OWN_WORK_MESSAGE;
    default:
      return CHANGED_SINCE_MESSAGE;
  }
}
