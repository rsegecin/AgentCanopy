import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { writeFileAtomic } from '../../util/files';
import { errorCode } from './fs-util';

/** Written when an agent turn starts and removed when it ends. One left behind means the turn was cut off. */
export const JournalSchema = z.object({
  turnId: z.string(),
  conversationId: z.string(),
  startedAt: z.number(),
  lastActivityAt: z.number(),
  pid: z.number().int().nullable(),
  /** When the process started, to tell it from an unrelated process that reuses its pid. */
  processStart: z.string().optional(),
});
export type Journal = z.infer<typeof JournalSchema>;

export type JournalRead = { kind: 'none' } | { kind: 'ok'; journal: Journal } | { kind: 'corrupt' };

export async function readJournal(file: string): Promise<JournalRead> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'ok', journal: parsed.data } : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

export async function writeJournal(file: string, journal: Journal): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(journal));
}

export async function removeJournal(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}
