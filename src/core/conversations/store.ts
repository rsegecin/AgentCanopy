import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ConversationIdSchema,
  ConversationMetaSchema,
  MessageSchema,
  PromptSchema,
  TurnSchema,
} from '../../shared';
import type {
  ConversationId,
  ConversationMeta,
  FolderKey,
  ForkInfo,
  Message,
  MessageId,
  Mode,
  Prompt,
  TurnId,
  Turn,
} from '../../shared';
import { silentLogger, systemClock } from '../contracts/ports';
import type { Clock, Logger } from '../contracts/ports';
import {
  LineAppender,
  ensurePrivateDir,
  newId,
  readJsonFile,
  readJsonLines,
  writeFileAtomic,
} from '../util';

export interface ConversationData {
  meta: ConversationMeta;
  turns: Turn[];
  messages: Message[];
  prompts: Prompt[];
}

export interface ConversationSearchHit {
  conversationId: ConversationId;
  title: string;
  snippet: string;
}

export interface ConversationStore {
  /** Creates the directory and loads the index, rebuilding it from the files when it cannot be trusted. */
  init(): Promise<void>;
  /** Newest `updatedAt` first. */
  list(): ConversationMeta[];
  create(input: {
    folder: FolderKey;
    providerId: string;
    model: string;
    mode: Mode;
    title?: string;
    fork?: ForkInfo;
    /** Create it with Agent mode's Auto on (the user confirmed it for the draft). */
    agentAuto?: boolean;
    /** When that Auto was turned on (`ConversationMeta.agentAutoSince`); kept only with `agentAuto`. */
    agentAutoSince?: number;
  }): Promise<ConversationMeta>;
  load(id: ConversationId): Promise<ConversationData | undefined>;
  /** Setting a key to `undefined` clears it. `updatedAt` is always set from the clock. */
  updateMeta(
    id: ConversationId,
    patch: Partial<Omit<ConversationMeta, 'id' | 'createdAt' | 'folder'>>,
  ): Promise<ConversationMeta>;
  /** Insert or replace by turn id. */
  putTurn(id: ConversationId, turn: Turn): Promise<void>;
  /** Insert or replace by message id. */
  putMessage(id: ConversationId, message: Message): Promise<void>;
  putPrompt(id: ConversationId, prompt: Prompt): Promise<void>;
  delete(id: ConversationId): Promise<void>;
  search(query: string, limit?: number): Promise<ConversationSearchHit[]>;
  /** Forks at a turn boundary. See the implementation plan, section 2.7. */
  fork(input: {
    parentId: ConversationId;
    atMessageId: MessageId;
  }): Promise<{ meta: ConversationMeta; prefill: string | undefined }>;
  /** Resolves when every queued write, including the index, is on disk. */
  flush(): Promise<void>;
}

export interface ConversationStoreOptions {
  dir: string;
  clock?: Clock;
  logger?: Logger;
  /** Rewrite a conversation file once it holds more than this many superseded records. Default 500. */
  compactAfterSuperseded?: number;
}

const INDEX_FILE = 'index.json';
const INDEX_DEBOUNCE_MS = 250;
const DEFAULT_TITLE = 'New conversation';
const BRANCH_SUFFIX = ' (branch)';
const MAX_TITLE = 200;
const SNIPPET_LENGTH = 120;

const RecordSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('meta'), meta: ConversationMetaSchema }),
  z.object({ t: z.literal('turn'), turn: TurnSchema }),
  z.object({ t: z.literal('message'), message: MessageSchema }),
  z.object({ t: z.literal('prompt'), prompt: PromptSchema }),
]);
type StoredRecord = z.infer<typeof RecordSchema>;

const IndexSchema = z.object({
  version: z.literal(1),
  conversations: z.array(ConversationMetaSchema),
});

const MetaPatchSchema = ConversationMetaSchema.omit({
  id: true,
  createdAt: true,
  folder: true,
})
  .partial()
  .strict();

interface Folded {
  meta: ConversationMeta | undefined;
  turns: Map<string, Turn>;
  messages: Map<string, Message>;
  prompts: Map<string, Prompt>;
  /** Lines that were torn, not JSON, or not a valid record. */
  invalid: number;
  /** Every line that was read, valid or not. */
  total: number;
}

/** The last record for an id wins; the position of an id is where it first appeared. */
function fold(values: unknown[], badLines: number): Folded {
  const folded: Folded = {
    meta: undefined,
    turns: new Map(),
    messages: new Map(),
    prompts: new Map(),
    invalid: badLines,
    total: values.length + badLines,
  };
  for (const value of values) {
    const parsed = RecordSchema.safeParse(value);
    if (!parsed.success) {
      folded.invalid += 1;
      continue;
    }
    const record = parsed.data;
    switch (record.t) {
      case 'meta':
        folded.meta = record.meta;
        break;
      case 'turn':
        folded.turns.set(record.turn.id, record.turn);
        break;
      case 'message':
        folded.messages.set(record.message.id, record.message);
        break;
      case 'prompt':
        folded.prompts.set(record.prompt.id, record.prompt);
        break;
    }
  }
  return folded;
}

function liveKeys(folded: Folded): Set<string> {
  const keys = new Set<string>();
  if (folded.meta) keys.add('meta');
  for (const id of folded.turns.keys()) keys.add(`turn:${id}`);
  for (const id of folded.messages.keys()) keys.add(`message:${id}`);
  for (const id of folded.prompts.keys()) keys.add(`prompt:${id}`);
  return keys;
}

function liveRecords(meta: ConversationMeta, folded: Folded): StoredRecord[] {
  return [
    { t: 'meta', meta },
    ...[...folded.turns.values()].map((turn): StoredRecord => ({ t: 'turn', turn })),
    ...[...folded.messages.values()].map((message): StoredRecord => ({ t: 'message', message })),
    ...[...folded.prompts.values()].map((prompt): StoredRecord => ({ t: 'prompt', prompt })),
  ];
}

function toLines(records: StoredRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

/** Per-conversation write state. Every operation on one conversation runs through `tail`. */
interface ConvState {
  path: string;
  appender: LineAppender;
  tail: Promise<void>;
  /** False until the file has been read once to learn what is already in it. */
  hydrated: boolean;
  total: number;
  live: Set<string>;
  /** The file ends in a torn line; terminate it before the next record. */
  needsNewline: boolean;
}

const noop = (): void => undefined;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function snippetAround(text: string, index: number, length: number): string {
  const width = Math.max(SNIPPET_LENGTH, length);
  const start = Math.max(0, index - Math.floor((width - length) / 2));
  const end = Math.min(text.length, start + width);
  const window = text.slice(start, end).replace(/\s*[\r\n]+\s*/g, ' ');
  return `${start > 0 ? '…' : ''}${window.trim()}${end < text.length ? '…' : ''}`;
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match ? snippetAround(text, match.index, match[0].length) : undefined;
}

function truncateTitle(title: string): string {
  return title.length <= MAX_TITLE - BRANCH_SUFFIX.length
    ? title
    : title.slice(0, MAX_TITLE - BRANCH_SUFFIX.length);
}

class Store implements ConversationStore {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly compactAfter: number;

  private readonly metas = new Map<ConversationId, ConversationMeta>();
  private readonly states = new Map<ConversationId, ConvState>();

  private indexTimer: NodeJS.Timeout | undefined;
  private indexDirty = false;
  private indexRun: Promise<void> = Promise.resolve();

  constructor(options: ConversationStoreOptions) {
    this.dir = options.dir;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.compactAfter = options.compactAfterSuperseded ?? 500;
  }

  // ---- startup ---------------------------------------------------------------------------------

  async init(): Promise<void> {
    await ensurePrivateDir(this.dir);
    this.metas.clear();
    this.states.clear();

    const files = await this.listFiles();
    const indexed = await this.readIndex();
    if (indexed && this.indexAgrees(indexed.metas, indexed.mtimeMs, files)) {
      for (const meta of indexed.metas) this.metas.set(meta.id, meta);
      return;
    }
    this.logger.info('rebuilding the conversation index', { files: files.size });
    await this.rebuildIndex(files);
  }

  private indexPath(): string {
    return join(this.dir, INDEX_FILE);
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  /** Conversation files present, by id, with their modification time. */
  private async listFiles(): Promise<Map<ConversationId, number>> {
    const found = new Map<ConversationId, number>();
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.jsonl') || name.startsWith('.')) continue;
      const parsed = ConversationIdSchema.safeParse(name.slice(0, -'.jsonl'.length));
      if (!parsed.success) continue;
      try {
        found.set(parsed.data, (await fs.stat(join(this.dir, name))).mtimeMs);
      } catch {
        // Vanished between listing and stat; treat as absent.
      }
    }
    return found;
  }

  private async readIndex(): Promise<{ metas: ConversationMeta[]; mtimeMs: number } | undefined> {
    try {
      const raw = await readJsonFile(this.indexPath());
      if (raw === undefined) return undefined;
      const parsed = IndexSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn('the conversation index is invalid');
        return undefined;
      }
      const stat = await fs.stat(this.indexPath());
      return { metas: parsed.data.conversations, mtimeMs: stat.mtimeMs };
    } catch (error) {
      this.logger.warn('the conversation index could not be read', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** The index is a cache. It is trusted only when it lists exactly the files present and none is newer. */
  private indexAgrees(
    metas: ConversationMeta[],
    indexMtimeMs: number,
    files: Map<ConversationId, number>,
  ): boolean {
    const ids = new Set(metas.map((meta) => meta.id));
    if (ids.size !== metas.length || ids.size !== files.size) return false;
    for (const [id, mtimeMs] of files) {
      if (!ids.has(id) || mtimeMs > indexMtimeMs) return false;
    }
    return true;
  }

  private async rebuildIndex(files: Map<ConversationId, number>): Promise<void> {
    for (const id of files.keys()) {
      const { values, badLines } = await readJsonLines(this.filePath(id));
      const folded = fold(values, badLines);
      if (folded.invalid > 0) {
        this.logger.warn('skipped invalid records', { conversation: id, count: folded.invalid });
      }
      if (!folded.meta || folded.meta.id !== id) {
        this.logger.warn('ignored a conversation file without valid metadata', { file: id });
        continue;
      }
      // The file's meta record is not rewritten by every put, so derive the last activity from content.
      let updatedAt = folded.meta.updatedAt;
      for (const turn of folded.turns.values()) {
        updatedAt = Math.max(updatedAt, turn.endedAt ?? turn.startedAt);
      }
      for (const message of folded.messages.values()) {
        updatedAt = Math.max(updatedAt, message.createdAt);
      }
      this.metas.set(id, { ...folded.meta, updatedAt });
    }
    this.indexDirty = true;
    await this.writeIndexNow();
  }

  // ---- index writing ---------------------------------------------------------------------------

  private scheduleIndex(): void {
    this.indexDirty = true;
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      void this.writeIndexNow();
    }, INDEX_DEBOUNCE_MS);
    this.indexTimer.unref();
  }

  private writeIndexNow(): Promise<void> {
    this.indexRun = this.indexRun.then(async () => {
      if (!this.indexDirty) return;
      this.indexDirty = false;
      try {
        const index = { version: 1, conversations: this.list() };
        await writeFileAtomic(this.indexPath(), `${JSON.stringify(index)}\n`);
      } catch (error) {
        // The index is a cache; the files are the truth. Try again on the next change or flush.
        this.indexDirty = true;
        this.logger.warn('could not write the conversation index', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return this.indexRun;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => state.tail));
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = undefined;
    }
    await this.writeIndexNow();
  }

  // ---- queue and per-conversation state ---------------------------------------------------------

  private stateFor(id: ConversationId, fresh = false): ConvState {
    let state = this.states.get(id);
    if (!state) {
      const path = this.filePath(id);
      state = {
        path,
        appender: new LineAppender(path),
        tail: Promise.resolve(),
        hydrated: fresh,
        total: 0,
        live: new Set(),
        needsNewline: false,
      };
      this.states.set(id, state);
    }
    return state;
  }

  private enqueue<T>(state: ConvState, task: () => Promise<T>): Promise<T> {
    const run = state.tail.then(task);
    state.tail = run.then(noop, noop);
    return run;
  }

  private requireMeta(id: ConversationId): ConversationMeta {
    const meta = this.metas.get(id);
    if (!meta) throw new Error(`unknown conversation ${id}`);
    return meta;
  }

  /** Learns what a file already holds, once, so superseded records can be counted. Runs in the queue. */
  private async hydrate(state: ConvState): Promise<void> {
    if (state.hydrated) return;
    const { values, badLines } = await readJsonLines(state.path);
    const folded = fold(values, badLines);
    state.total = folded.total;
    state.live = liveKeys(folded);
    state.needsNewline = await this.endsWithTornLine(state.path);
    state.hydrated = true;
  }

  private async endsWithTornLine(path: string): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, 'r');
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  }

  /** Appends one record. Runs in the queue. */
  private async appendRecord(
    id: ConversationId,
    state: ConvState,
    line: string,
    key: string,
  ): Promise<void> {
    await this.hydrate(state);
    if (state.needsNewline) {
      await state.appender.append('');
      state.needsNewline = false;
      // The torn fragment is now a complete, invalid line.
    }
    await state.appender.append(line);
    state.total += 1;
    state.live.add(key);
    if (state.total - state.live.size > this.compactAfter) await this.compact(id, state);
  }

  /** Rewrites the file with only the live records. Runs in the queue, so no append is in flight. */
  private async compact(id: ConversationId, state: ConvState): Promise<void> {
    try {
      const { values, badLines } = await readJsonLines(state.path);
      const folded = fold(values, badLines);
      const meta = this.metas.get(id) ?? folded.meta;
      if (!meta) return;
      const records = liveRecords(meta, folded);
      await writeFileAtomic(state.path, toLines(records));
      state.total = records.length;
      state.live = liveKeys({ ...folded, meta });
      state.needsNewline = false;
      this.logger.debug('compacted a conversation', { conversation: id, records: records.length });
    } catch (error) {
      this.logger.warn('could not compact a conversation', {
        conversation: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private bump(id: ConversationId): void {
    const meta = this.metas.get(id);
    if (!meta) return;
    this.metas.set(id, { ...meta, updatedAt: this.clock.now() });
    this.scheduleIndex();
  }

  // ---- reads -----------------------------------------------------------------------------------

  list(): ConversationMeta[] {
    return [...this.metas.values()].sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        b.createdAt - a.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  async load(id: ConversationId): Promise<ConversationData | undefined> {
    if (!this.metas.has(id)) return undefined;
    const state = this.stateFor(id);
    return this.enqueue(state, async () => {
      const { values, badLines } = await readJsonLines(state.path);
      const folded = fold(values, badLines);
      if (folded.invalid > 0) {
        this.logger.warn('skipped invalid records', { conversation: id, count: folded.invalid });
      }
      const meta = this.metas.get(id) ?? folded.meta;
      if (!meta || !folded.meta) {
        this.logger.warn('a conversation has no readable metadata', { conversation: id });
        return undefined;
      }
      return {
        meta,
        turns: [...folded.turns.values()],
        messages: [...folded.messages.values()],
        prompts: [...folded.prompts.values()],
      };
    });
  }

  async search(query: string, limit = 50): Promise<ConversationSearchHit[]> {
    const needle = query.trim();
    if (needle.length === 0 || limit <= 0) return [];
    const pattern = new RegExp(escapeRegExp(needle), 'i');
    const hits: ConversationSearchHit[] = [];
    const rest: ConversationMeta[] = [];

    for (const meta of this.list()) {
      const snippet = firstMatch(meta.title, pattern);
      if (snippet === undefined) rest.push(meta);
      else hits.push({ conversationId: meta.id, title: meta.title, snippet });
    }
    if (hits.length >= limit) return hits.slice(0, limit);

    for (const meta of rest) {
      const data = await this.load(meta.id);
      if (!data) continue;
      const snippet = this.firstMessageMatch(data.messages, pattern);
      if (snippet === undefined) continue;
      hits.push({ conversationId: meta.id, title: meta.title, snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private firstMessageMatch(messages: Message[], pattern: RegExp): string | undefined {
    for (const message of messages) {
      if (message.role === 'user') {
        const snippet = firstMatch(message.text, pattern);
        if (snippet !== undefined) return snippet;
        continue;
      }
      for (const part of message.parts) {
        if (part.kind !== 'text') continue;
        const snippet = firstMatch(part.text, pattern);
        if (snippet !== undefined) return snippet;
      }
    }
    return undefined;
  }

  // ---- writes ----------------------------------------------------------------------------------

  async create(input: {
    folder: FolderKey;
    providerId: string;
    model: string;
    mode: Mode;
    title?: string;
    fork?: ForkInfo;
    /** Create it with Agent mode's Auto on (the user confirmed it for the draft). */
    agentAuto?: boolean;
    /** When that Auto was turned on (`ConversationMeta.agentAutoSince`); kept only with `agentAuto`. */
    agentAutoSince?: number;
  }): Promise<ConversationMeta> {
    const now = this.clock.now();
    const meta = ConversationMetaSchema.parse({
      id: newId<ConversationId>(),
      title: input.title ?? DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      folder: input.folder,
      providerId: input.providerId,
      model: input.model,
      mode: input.mode,
      ...(input.fork ? { fork: input.fork } : {}),
      planLocked: false,
      ...(input.agentAuto === true ? { agentAuto: true } : {}),
      ...(input.agentAuto === true && input.agentAutoSince !== undefined
        ? { agentAutoSince: input.agentAutoSince }
        : {}),
    });
    const line = JSON.stringify({ t: 'meta', meta } satisfies StoredRecord);
    const state = this.stateFor(meta.id, true);
    this.metas.set(meta.id, meta);
    try {
      await this.enqueue(state, async () => {
        await state.appender.append(line);
        state.total += 1;
        state.live.add('meta');
      });
    } catch (error) {
      this.metas.delete(meta.id);
      this.states.delete(meta.id);
      throw error;
    }
    this.scheduleIndex();
    return meta;
  }

  async updateMeta(
    id: ConversationId,
    patch: Partial<Omit<ConversationMeta, 'id' | 'createdAt' | 'folder'>>,
  ): Promise<ConversationMeta> {
    const previous = this.requireMeta(id);
    MetaPatchSchema.parse(patch);
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    merged.updatedAt = this.clock.now();
    const next = ConversationMetaSchema.parse(merged);
    const line = JSON.stringify({ t: 'meta', meta: next } satisfies StoredRecord);

    const state = this.stateFor(id);
    this.metas.set(id, next);
    try {
      await this.enqueue(state, () => this.appendRecord(id, state, line, 'meta'));
    } catch (error) {
      if (this.metas.get(id) === next) this.metas.set(id, previous);
      throw error;
    }
    this.scheduleIndex();
    return next;
  }

  async putTurn(id: ConversationId, turn: Turn): Promise<void> {
    this.requireMeta(id);
    const valid = TurnSchema.parse(turn);
    return this.putRecord(id, { t: 'turn', turn: valid }, `turn:${valid.id}`);
  }

  async putMessage(id: ConversationId, message: Message): Promise<void> {
    this.requireMeta(id);
    const valid = MessageSchema.parse(message);
    return this.putRecord(id, { t: 'message', message: valid }, `message:${valid.id}`);
  }

  async putPrompt(id: ConversationId, prompt: Prompt): Promise<void> {
    this.requireMeta(id);
    const valid = PromptSchema.parse(prompt);
    if (valid.conversationId !== id) {
      throw new Error('the prompt belongs to a different conversation');
    }
    return this.putRecord(id, { t: 'prompt', prompt: valid }, `prompt:${valid.id}`);
  }

  private putRecord(id: ConversationId, record: StoredRecord, key: string): Promise<void> {
    const line = JSON.stringify(record);
    const state = this.stateFor(id);
    return this.enqueue(state, async () => {
      await this.appendRecord(id, state, line, key);
      this.bump(id);
    });
  }

  async delete(id: ConversationId): Promise<void> {
    if (this.metas.delete(id)) this.scheduleIndex();
    const state = this.stateFor(id);
    await this.enqueue(state, () => fs.rm(state.path, { force: true }));
    this.states.delete(id);
  }

  // ---- forking ---------------------------------------------------------------------------------

  async fork(input: {
    parentId: ConversationId;
    atMessageId: MessageId;
  }): Promise<{ meta: ConversationMeta; prefill: string | undefined }> {
    const parent = await this.load(input.parentId);
    if (!parent) throw new Error(`unknown conversation ${input.parentId}`);
    const index = parent.messages.findIndex((message) => message.id === input.atMessageId);
    const target = parent.messages[index];
    if (!target) throw new Error(`unknown message ${input.atMessageId}`);

    // Fork points are turn boundaries.
    let first = Infinity;
    let last = -1;
    parent.messages.forEach((message, position) => {
      if (message.turnId !== target.turnId) return;
      first = Math.min(first, position);
      last = Math.max(last, position);
    });
    const keepCount = target.role === 'assistant' ? last + 1 : first;
    const prefill = target.role === 'user' ? target.text : undefined;
    const kept = parent.messages.slice(0, keepCount);

    const turnIds = new Map<TurnId, TurnId>();
    for (const message of kept) {
      if (!turnIds.has(message.turnId)) turnIds.set(message.turnId, newId<TurnId>());
    }
    const records: StoredRecord[] = [];
    for (const turn of parent.turns) {
      const turnId = turnIds.get(turn.id);
      if (!turnId) continue;
      const copy = structuredClone(turn);
      // A turn that was still going when the branch was cut will never finish in the branch.
      const status =
        copy.status === 'running' || copy.status === 'preparing' ? 'interrupted' : copy.status;
      records.push({ t: 'turn', turn: { ...copy, id: turnId, status } });
    }
    for (const message of kept) {
      records.push({ t: 'message', message: this.copyMessage(message, turnIds) });
    }

    const lastKept = kept[kept.length - 1];
    const now = this.clock.now();
    const meta = ConversationMetaSchema.parse({
      id: newId<ConversationId>(),
      title: `${truncateTitle(parent.meta.title)}${BRANCH_SUFFIX}`,
      createdAt: now,
      updatedAt: now,
      folder: parent.meta.folder,
      providerId: parent.meta.providerId,
      model: parent.meta.model,
      mode: parent.meta.mode,
      fork: {
        parentId: parent.meta.id,
        atMessageId: lastKept?.id ?? input.atMessageId,
        // The parent's own id of the last turn the branch keeps: what a later copy of the session is measured against.
        ...(lastKept ? { lastKeptParentTurnId: lastKept.turnId } : {}),
        exactness: 'pending',
        lost: [],
      },
      planLocked: false,
    });
    records.unshift({ t: 'meta', meta });

    const state = this.stateFor(meta.id, true);
    try {
      await this.enqueue(state, async () => {
        await writeFileAtomic(state.path, toLines(records));
        state.total = records.length;
        state.live = new Set(
          records.map((record) => {
            switch (record.t) {
              case 'meta':
                return 'meta';
              case 'turn':
                return `turn:${record.turn.id}`;
              case 'message':
                return `message:${record.message.id}`;
              case 'prompt':
                return `prompt:${record.prompt.id}`;
            }
          }),
        );
      });
    } catch (error) {
      this.states.delete(meta.id);
      throw error;
    }
    this.metas.set(meta.id, meta);
    this.scheduleIndex();
    return { meta, prefill };
  }

  private copyMessage(message: Message, turnIds: Map<TurnId, TurnId>): Message {
    const copy = structuredClone(message);
    const turnId = turnIds.get(copy.turnId) ?? copy.turnId;
    const id = newId<MessageId>();
    if (copy.role === 'user') return { ...copy, id, turnId };
    const parts = copy.parts
      .filter((part) => part.kind !== 'prompt')
      .map((part) =>
        part.kind === 'tool' &&
        (part.call.status === 'running' || part.call.status === 'awaiting-approval')
          ? { ...part, call: { ...part.call, status: 'not-run' as const } }
          : part,
      );
    return { ...copy, id, turnId, parts };
  }
}

export function createConversationStore(options: ConversationStoreOptions): ConversationStore {
  return new Store(options);
}
