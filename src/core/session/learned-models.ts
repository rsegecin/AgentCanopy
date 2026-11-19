import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { silentLogger, type Logger } from '../contracts';
import { isNotFound, redact, writeFileAtomic } from '../util';

/** The file in the global storage directory that holds the full model ids learned from turns. */
export const LEARNED_MODELS_FILE = 'learned-models.json';

const MAX_PROVIDERS = 10;
const MAX_ALIASES = 50;

/** What the CLI accepts as a model name; the same pattern as `MODEL` in the Claude invocation. */
const ModelId = z.string().regex(/^[A-Za-z0-9._:[\]/@-]{1,100}$/);
const ProviderId = z.string().min(1).max(64);
const Alias = z.string().min(1).max(64);

const FileSchema = z.object({
  version: z.literal(1),
  providers: z
    .record(ProviderId, z.record(Alias, ModelId))
    .refine((providers) => Object.keys(providers).length <= MAX_PROVIDERS)
    .refine((providers) =>
      Object.values(providers).every((aliases) => Object.keys(aliases).length <= MAX_ALIASES),
    ),
});

/** Provider id to alias to full id. Maps, so that no key can reach a prototype. */
type Data = Map<string, Map<string, string>>;

/**
 * Adds what `extra` holds that `data` does not, as far as the caps allow. What `data` holds is kept
 * as it is.
 */
function addMissing(data: Data, extra: Data): void {
  for (const [provider, aliases] of extra) {
    let target = data.get(provider);
    if (target === undefined) {
      if (data.size >= MAX_PROVIDERS) continue;
      target = new Map();
      data.set(provider, target);
    }
    for (const [alias, id] of aliases) {
      if (target.has(alias) || target.size >= MAX_ALIASES) continue;
      target.set(alias, id);
    }
  }
}

/** Sets one entry, unless the caps forbid it. Returns whether it was set. */
function setEntry(data: Data, provider: string, alias: string, id: string): boolean {
  let target = data.get(provider);
  if (target === undefined) {
    if (data.size >= MAX_PROVIDERS) return false;
    target = new Map();
    data.set(provider, target);
  } else if (!target.has(alias) && target.size >= MAX_ALIASES) {
    return false;
  }
  target.set(alias, id);
  return true;
}

/** An entry recorded and not yet written to the file. */
type Pending = readonly [provider: string, alias: string, id: string];

/** What a read of the file found. */
type Read =
  | { kind: 'ok'; data: Data }
  /** No file, or one that holds nothing usable: nothing learned. It may be written over. */
  | { kind: 'empty' }
  /** The file could not be read. It is not written over, since what it holds is not known. */
  | { kind: 'unreadable' };

/**
 * The full model ids that finished turns reported for an alias such as `opus`, kept per provider and
 * shared by every window through the global storage directory. They only shape the labels of the
 * model selector, so every doubt fails open: a file that cannot be read or used counts as empty, and
 * a write that fails is logged and forgotten, while memory keeps the value.
 *
 * The file is the truth shared by the windows: what it holds wins over memory, so the window that
 * recorded an alias last decides it. The one exception is a record of this window that is not yet
 * written, which wins until it is.
 */
export interface LearnedModels {
  /** What is known for a provider right now: alias to full id. A fresh object on each call. */
  get(providerId: string): Record<string, string>;
  /**
   * Remembers that an alias ran as an id. Returns true when memory changed, false when the input is
   * not valid, a cap would be exceeded, or the value is already held. Memory changes at once; the
   * file is written in the background, read again first and with this entry set over what it holds,
   * so another window's entries are kept.
   */
  record(providerId: string, alias: string, id: string): boolean;
  /**
   * Reads the file and takes it into memory: what the file holds wins over memory, except for a
   * record not yet written. Entries only memory holds are kept. Never writes, never throws.
   */
  refresh(): Promise<void>;
  /** Resolves when every read and write asked for so far has finished. Never rejects. */
  idle(): Promise<void>;
}

export function createLearnedModels(deps: {
  /** The global storage directory; without it everything lives in memory only. */
  dir: string | undefined;
  logger?: Logger;
}): LearnedModels {
  const logger = deps.logger ?? silentLogger;
  const file = deps.dir === undefined ? undefined : join(deps.dir, LEARNED_MODELS_FILE);
  let memory: Data = new Map();
  let queue: Promise<unknown> = Promise.resolve();

  async function read(path: string): Promise<Read> {
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { kind: 'empty' };
      logger.warn('the learned model ids could not be read', { error: redact(String(error)) });
      return { kind: 'unreadable' };
    }
    let parsed: ReturnType<typeof FileSchema.safeParse>;
    try {
      parsed = FileSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = FileSchema.safeParse(undefined);
    }
    if (!parsed.success) {
      logger.warn('the learned model ids could not be used; none are taken from the file');
      return { kind: 'empty' };
    }
    const data: Data = new Map();
    for (const [provider, aliases] of Object.entries(parsed.data.providers)) {
      data.set(provider, new Map(Object.entries(aliases)));
    }
    return { kind: 'ok', data };
  }

  /** Entries recorded here that no write of the file has taken yet, oldest first. */
  const pending: Pending[] = [];

  /** Makes `data` the memory, with the records not yet written on top of it. */
  function adopt(data: Data): void {
    for (const [provider, alias, id] of pending) {
      const aliases = data.get(provider) ?? new Map<string, string>();
      aliases.set(alias, id);
      data.set(provider, aliases);
    }
    memory = data;
  }

  async function persist(path: string): Promise<void> {
    // Taken before the read: a record that comes in later stays pending and has its own write.
    const batch = pending.slice();
    if (batch.length === 0) return;
    const found = await read(path);
    // A file that cannot be read may hold what another window learned; it is not written over.
    if (found.kind === 'unreadable') return;
    forget(batch);
    const data: Data = found.kind === 'ok' ? found.data : new Map<string, Map<string, string>>();
    let set = 0;
    for (const [provider, alias, id] of batch) {
      if (setEntry(data, provider, alias, id)) {
        set += 1;
      } else {
        logger.warn('a learned model id was not stored: the file holds as many as it may');
      }
    }
    if (set === 0) return;
    // What only memory holds, such as an entry whose earlier write failed, is tried again.
    addMissing(data, memory);
    adopt(data);
    const providers = Object.fromEntries(
      [...data].map(([provider, aliases]) => [provider, Object.fromEntries(aliases)]),
    );
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, providers })}\n`);
  }

  /** Takes the entries of a batch off the pending list. */
  function forget(batch: readonly Pending[]): void {
    for (const entry of batch) {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    }
  }

  /** One read and write of the file at a time, in order. A failure is logged and goes no further. */
  function enqueue(task: (path: string) => Promise<void>): Promise<void> {
    if (file === undefined) return Promise.resolve();
    const path = file;
    const run = queue
      .then(() => task(path))
      .catch((error: unknown) => {
        logger.warn('the learned model ids could not be stored', { error: redact(String(error)) });
      });
    queue = run;
    return run;
  }

  return {
    get(providerId) {
      const aliases = memory.get(providerId);
      return aliases === undefined ? {} : Object.fromEntries(aliases);
    },
    record(providerId, alias, id) {
      if (
        !ProviderId.safeParse(providerId).success ||
        !Alias.safeParse(alias).success ||
        !ModelId.safeParse(id).success
      ) {
        return false;
      }
      const aliases = memory.get(providerId);
      if (aliases === undefined && memory.size >= MAX_PROVIDERS) return false;
      if (aliases !== undefined && !aliases.has(alias) && aliases.size >= MAX_ALIASES) return false;
      if (aliases?.get(alias) === id) return false;
      const target = aliases ?? new Map<string, string>();
      target.set(alias, id);
      memory.set(providerId, target);
      pending.push([providerId, alias, id]);
      void enqueue(persist);
      return true;
    },
    refresh() {
      return enqueue(async (path) => {
        const found = await read(path);
        if (found.kind !== 'ok') return;
        // The file over memory; what only memory holds is kept.
        addMissing(found.data, memory);
        adopt(found.data);
      });
    },
    idle: () => queue.then(() => undefined),
  };
}
