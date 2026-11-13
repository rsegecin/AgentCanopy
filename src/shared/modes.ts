import * as z from 'zod';

export const MODES = ['ask', 'plan', 'agent'] as const;
export const ModeSchema = z.enum(MODES);
export type Mode = z.infer<typeof ModeSchema>;

/** Ask and Plan never modify the workspace. */
export function isReadOnlyMode(mode: Mode): boolean {
  return mode !== 'agent';
}
