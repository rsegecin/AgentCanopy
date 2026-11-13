import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FolderKey } from '../../../shared';
import { silentLogger, type Logger } from '../../contracts';

const FOLDER_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.json$/;

export type ProjectConfigDecision = 'use' | 'ignore';

export interface ProjectConfigDecisions {
  /** Creates the directory if needed and loads every file. Call once before the other methods. */
  init(): Promise<void>;
  /** The stored decision, only when it was made for this very fingerprint. */
  get(folderKey: FolderKey, fingerprint: string): ProjectConfigDecision | undefined;
  set(folderKey: FolderKey, fingerprint: string, decision: ProjectConfigDecision): Promise<void>;
  reset(folderKey: FolderKey): Promise<void>;
}

const FileSchema = z.object({
  fingerprint: z.string().min(1).max(200),
  decision: z.enum(['use', 'ignore']),
});
type Stored = z.infer<typeof FileSchema>;

function checkKey(folderKey: string): void {
  if (!FOLDER_KEY.test(folderKey)) throw new Error('That folder key cannot be used.');
}

/** The user's choice about a project's own Claude Code configuration, one per folder and content. */
export function createProjectConfigDecisions(options: {
  dir: string;
  logger?: Logger;
}): ProjectConfigDecisions {
  const { dir } = options;
  const logger = options.logger ?? silentLogger;
  const decisions = new Map<string, Stored>();
  let opened = false;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async init() {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      decisions.clear();
      for (const file of await fs.readdir(dir)) {
        const key = FILE_NAME.exec(file)?.[1];
        if (key === undefined) continue;
        try {
          decisions.set(
            key,
            FileSchema.parse(JSON.parse(await fs.readFile(join(dir, file), 'utf8'))),
          );
        } catch (error) {
          logger.warn('A project configuration decision could not be read and is ignored.', {
            file,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      opened = true;
    },

    get(folderKey, fingerprint) {
      const stored = decisions.get(folderKey);
      return stored !== undefined && stored.fingerprint === fingerprint
        ? stored.decision
        : undefined;
    },

    set(folderKey, fingerprint, decision) {
      return enqueue(async () => {
        if (!opened) throw new Error('The decision store has not been opened.');
        checkKey(folderKey);
        const stored = FileSchema.parse({ fingerprint, decision });
        const target = join(dir, `${folderKey}.json`);
        const temp = join(dir, `.${folderKey}.${randomBytes(6).toString('hex')}.tmp`);
        try {
          await fs.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
          await fs.rename(temp, target);
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
        decisions.set(folderKey, stored);
      });
    },

    reset(folderKey) {
      return enqueue(async () => {
        if (!opened) throw new Error('The decision store has not been opened.');
        checkKey(folderKey);
        await fs.rm(join(dir, `${folderKey}.json`), { force: true });
        decisions.delete(folderKey);
      });
    },
  };
}
