import { describe, expect, it } from 'vitest';
import {
  CHANGED_SINCE_MESSAGE,
  MAY_HOLD_OWN_WORK_MESSAGE,
  UNSAVED_MESSAGE,
  hunkProblemMessage,
} from './hunk-messages';

const conflict = (reason: 'changed-since' | 'uncertain-source' | 'unsaved-editor') =>
  ({ status: 'conflict', reason, canRevertAgentOnly: false }) as const;

describe('hunkProblemMessage', () => {
  it('says nothing for a finished action', () => {
    expect(hunkProblemMessage({ status: 'done' })).toBeUndefined();
  });

  it('passes a refusal on as it is', () => {
    expect(hunkProblemMessage({ status: 'refused', message: 'Nope.' })).toBe('Nope.');
  });

  it('tells the user to save first when the editor has unsaved changes', () => {
    expect(hunkProblemMessage(conflict('unsaved-editor'))).toBe(UNSAVED_MESSAGE);
  });

  it('points a hunk of a file that may hold the user own work to Reject on the whole file', () => {
    expect(hunkProblemMessage(conflict('uncertain-source'))).toBe(
      'This file may include your own work. Use Reject on the whole file to choose what happens.',
    );
    expect(MAY_HOLD_OWN_WORK_MESSAGE).toContain('Reject on the whole file');
  });

  it('says the part changed since for any other conflict', () => {
    expect(hunkProblemMessage(conflict('changed-since'))).toBe(CHANGED_SINCE_MESSAGE);
  });
});
