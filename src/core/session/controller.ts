import { promises as fs } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import {
  AttachmentSchema,
  EMPTY_VIEW_STATE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PER_MESSAGE,
  RelPathSchema,
  WebviewMessageSchema,
} from '../../shared';
import type {
  Attachment,
  Banner,
  CheckpointSummary,
  ConversationId,
  ConversationMeta,
  FolderKey,
  ImageMediaType,
  MessageId,
  Mode,
  PlanDoc,
  PlanId,
  PromptAnswer,
  OperationId,
  PromptId,
  ProviderStatus,
  QueuedMessage,
  RelPath,
  RestorePreview,
  WebviewMessage,
} from '../../shared';
import type {
  AgentProvider,
  AppController,
  AppDeps,
  FolderInfo,
  Logger,
  ProjectConfigChoice,
  RejectResult,
  TurnImage,
  TurnObserver,
  TurnPolicy,
  ViewHandle,
  ViewSink,
} from '../contracts';
import { createFileSearch } from '../context';
import type { FileSearch } from '../context';
import { createConversationStore } from '../conversations/store';
import type { ConversationStore } from '../conversations/store';
import {
  createPlanStore,
  renderExecutionPrompt,
  renderPlanMarkdown,
  unansweredCount,
} from '../plans';
import type { PlanStore } from '../plans';
import {
  createAgentPolicy,
  createModePolicy,
  createReadOnlyPolicy,
  createReadOnlyTripwire,
  createRuleStore,
} from '../policy';
import type { RuleStore } from '../policy/agent';
import { createProjectConfigDecisions, inspectProjectConfig } from '../policy/project-config';
import { isAlive, stopOrphan } from '../provider/claude';
import { isNotFound, newId, redact, sha256Hex } from '../util';
import { collectGarbage } from '../workspace/store';
import { createCheckpointService } from '../workspace/checkpoints';
import { createReviewEngine } from '../workspace/review';
import { findGit } from '../workspace/tracker/git-state';
import { BUSY_MESSAGE, CONFIG_PENDING_MESSAGE } from '../workspace/tracker/tracker';
import { createWorkspaceTracker } from '../workspace/tracker';
import type { WorkspaceTracker } from '../workspace/tracker';

type ReviewEngine = ReturnType<typeof createReviewEngine>;
type CheckpointEngine = ReturnType<typeof createCheckpointService>;

/** What a checkpoint is called in a sentence: "the agent turn of Nov 11, 3:05 PM". */
export function checkpointLabel(operation: CheckpointSummary): string {
  const what: Record<CheckpointSummary['kind'], string> = {
    'agent-turn': 'the agent turn',
    reject: 'the rejection',
    restore: 'the restore',
    recovery: 'the recovery',
  };
  return `${what[operation.kind]} of ${formatCheckpointTime(operation.at)}`;
}

/** Where a review message goes: a toast in one view, or in every view of a folder. */
type Report = (level: 'info' | 'warning' | 'error', text: string) => void;
import { REFRESH_ACTION, SIGN_IN_ACTION, bannerKey, computeBanners } from './banners';
import { decodeBase64, matchesImageSignature } from './images';
import { isInside, resolveInsideWorkspace } from './paths';
import { alwaysAllowDetail, answerProblem, canonicalJson } from './prompts';
import type { PendingPrompt } from './prompts';
import { SessionState, previewOf } from './state';
import type { ConvRuntime } from './state';
import {
  TEXT,
  claudeNotInstalled,
  claudeSignedOut,
  claudeTooOld,
  formatCheckpointTime,
  safeText,
} from './text';
import { TurnRun } from './turn';
import type { TurnServices } from './turn';
import { ViewRecord } from './view';

const MAX_ATTACHMENTS = 50;
const MAX_SEARCH_RESULTS = 50;
/** Previews of stored conversations are published this many at a time after start-up. */
const PREVIEW_BATCH = 10;
/** A view's baseline status is patched at most this often. */
const BASELINE_MIN_INTERVAL_MS = 200;
/** Files named in the confirmation of "Reject all" that cannot be rejected. */
const MAX_LISTED_REFUSALS = 8;
const RECOVER_NOW_ACTION = { id: 'recover-now', label: 'Recover now' } as const;
const IDLE_BASELINE = EMPTY_VIEW_STATE.baseline;
const TITLE_LENGTH = 60;
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

type SendMessage = Extract<WebviewMessage, { type: 'turn.send' }>;

/** What differs when a turn is started by approving a plan instead of by the composer. */
interface TurnOptions {
  /** Runs after every check has passed and before anything is created. Returns the prompt, or false to stop. */
  gate?: () => Promise<{ promptText: string } | false>;
  /** Called once the turn exists and has been started. */
  onStarted?: (run: TurnRun) => void;
  /** The message does not take the view's queued attachments. */
  noAttachments?: boolean;
  /**
   * The message is one that was queued behind a turn: it takes these attachments instead of the
   * view's draft, and it is never queued again.
   */
  queuedInput?: { attachments: Attachment[] };
}

/** The message a conversation holds back while a turn runs in it. Kept in memory only. */
interface QueuedEntry {
  /** What the views show. */
  readonly message: QueuedMessage;
  /** The view that queued it. */
  readonly viewId: string;
  /** Set while it is being sent, so nothing else sends, edits or removes it. */
  sending: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The message type for a log line, reduced to plain characters. Nothing else of a message is logged. */
function typeOf(raw: unknown): string {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return 'unknown';
  return raw['type'].replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40);
}

function titleOf(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH).trim();
  return line.length > 0 ? line : undefined;
}

function assertNever(value: never): never {
  throw new Error(`unhandled message ${typeOf(value)}`);
}

class Controller implements AppController {
  private readonly deps: AppDeps;
  private readonly logger: Logger;
  /** `deps.policy`, or the default one once the storage directory is known. */
  private policy: TurnPolicy | undefined;
  private observers: TurnObserver[];
  private tracker: WorkspaceTracker | undefined;
  private engine: ReviewEngine | undefined;
  private readonly projectConfigGate: boolean;
  private projectConfigDecisions: ReturnType<typeof createProjectConfigDecisions> | undefined;
  /** Folder and fingerprint pairs whose "settings are ignored" notice was shown in this session. */
  private readonly projectConfigAnnounced = new Set<string>();
  private checkpoints: CheckpointEngine | undefined;
  private rules: RuleStore | undefined;
  private readonly unsubscribe: (() => void)[] = [];
  /** Folders the tracker has been asked to pre-warm. */
  private readonly prewarmed = new Set<FolderKey>();
  private recoveryDone = false;
  /** Folders whose interrupted turn could not be recovered yet. */
  private readonly unfinishedRecovery = new Set<FolderKey>();
  /** Banners about an interrupted turn that was cleaned up at start-up, by banner id. */
  private readonly recoveryBanners = new Map<string, Banner>();
  private readonly fileSearch: FileSearch;
  /** Previews found while checking stored conversations at start-up, not yet shown. */
  private pendingPreviews = new Map<ConversationId, string>();
  private readonly state: SessionState;
  private store: ConversationStore | undefined;
  private plans: PlanStore | undefined;
  /** Conversations about to start a turn that are waiting for a confirmation, so no second turn slips in. */
  private readonly reserved = new Set<ConversationId>();
  /** Conversations whose session is being copied for a branch: no turn may start in them meanwhile. */
  private readonly forkHolds = new Map<ConversationId, number>();
  private storageDir: string | undefined;
  private opening: Promise<void> | undefined;
  private readonly runs = new Map<ConversationId, TurnRun>();
  /**
   * At most one message per conversation, waiting for the turn that runs in it. Outlives the
   * conversation's runtime: a conversation that no view shows is released from memory.
   */
  private readonly queued = new Map<ConversationId, QueuedEntry>();
  /** Conversations whose queued message is being sent now by a "Send now". */
  private readonly sendingNow = new Set<ConversationId>();
  /**
   * Bytes of pasted images by id (the content hash), kept only while some view's draft or a queued
   * message refers to them; a turn takes its own copies when the message is sent.
   */
  private readonly imageBytes = new Map<string, Buffer>();
  private readonly prompts = new Map<PromptId, PendingPrompt>();
  private readonly loading = new Map<ConversationId, Promise<ConvRuntime | undefined>>();
  private readonly listeners = new Set<() => void>();
  /** Banners the user dismissed, by `bannerKey`. */
  private readonly dismissed = new Set<string>();
  private lastUsed: ViewRecord | undefined;
  private viewCount = 0;
  private started = false;
  private loaded = false;
  private disposed = false;
  private detectToken = 0;

  constructor(deps: AppDeps, options: { projectConfigGate?: boolean } = {}) {
    this.deps = deps;
    // Asked with the application's own policy; an injected one (tests) only when switched on.
    this.projectConfigGate = options.projectConfigGate ?? deps.policy === undefined;
    this.logger = deps.logger;
    this.policy = deps.policy;
    this.observers = deps.observers ?? [];
    this.fileSearch = createFileSearch({ logger: deps.logger });
    this.state = new SessionState(
      () => this.store?.list() ?? [],
      (view) => this.syncViewScope(view),
    );
  }

  // ---- life cycle --------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.recomputeEnvironment();
    await this.openStore();
    await this.startTracker();
    try {
      await this.deps.hostTools.start();
    } catch (error) {
      this.logger.error('the tool server could not start', { error: redact(String(error)) });
    }
    await this.refreshProvider();
    this.loaded = true;
    this.state.refreshSummaries();
    for (const view of [...this.state.views.values()]) void this.openInitial(view);
    this.fillPreviews();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        try {
          await run.cancel();
        } catch (error) {
          this.logger.warn('a turn could not be cancelled', { error: redact(String(error)) });
        }
        await run.done;
      }),
    );
    for (const off of this.unsubscribe.splice(0)) off();
    try {
      await this.tracker?.dispose();
    } catch (error) {
      this.logger.warn('the workspace tracker could not be disposed', {
        error: redact(String(error)),
      });
    }
    try {
      await this.store?.flush();
    } catch (error) {
      this.logger.warn('the conversation store could not be flushed', {
        error: redact(String(error)),
      });
    }
    try {
      await this.deps.hostTools.stop();
    } catch (error) {
      this.logger.warn('the tool server could not stop', { error: redact(String(error)) });
    }
    this.queued.clear();
    this.sendingNow.clear();
    for (const view of this.state.views.values()) view.dispose();
    this.state.views.clear();
    this.listeners.clear();
  }

  runningTurns(): number {
    return this.runs.size;
  }

  onDidChangeRunning(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fireRunningChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('a running listener failed', { error: redact(String(error)) });
      }
    }
  }

  // ---- environment and provider --------------------------------------------------------------------

  environmentChanged(): void {
    this.recomputeEnvironment();
    void this.startTracker();
    for (const view of this.state.views.values()) this.syncViewScope(view);
    if (!this.store && this.deps.env.storageDir() !== undefined) {
      this.openStore()
        .then(async () => {
          this.state.refreshSummaries();
          this.fillPreviews();
          await this.startTracker();
        })
        .catch((error: unknown) => {
          this.logger.error('the conversation store could not be opened', {
            error: redact(String(error)),
          });
        });
    }
  }

  private recomputeEnvironment(): void {
    const { env } = this.deps;
    this.fileSearch.invalidate();
    const settings = env.settings();
    const provider = this.provider();
    const status = this.state.global.provider;
    this.state.patchGlobal({
      trusted: env.trusted(),
      folders: env.folders().map((folder) => ({ key: folder.key, name: folder.name })),
      defaults: { mode: settings.defaultMode, model: settings.defaultModel },
      models: provider ? provider.listModels(settings.customModels) : [],
      banners: this.banners(status),
    });
  }

  async refreshProvider(): Promise<void> {
    const provider = this.provider();
    const token = ++this.detectToken;
    if (!provider) {
      this.state.patchGlobal({ provider: null, models: [], banners: this.banners(null) });
      return;
    }
    const status = await provider.detect();
    if (token !== this.detectToken || this.disposed) return;
    this.state.patchGlobal({
      provider: status,
      models: provider.listModels(this.deps.env.settings().customModels),
      banners: this.banners(status),
    });
  }

  private provider(): AgentProvider | undefined {
    return this.deps.providers.list()[0];
  }

  private banners(provider: ProviderStatus | null): Banner[] {
    const { env } = this.deps;
    const all = computeBanners({
      trusted: env.trusted(),
      folderCount: env.folders().length,
      provider,
    });
    all.push(...this.recoveryBanners.values());
    const present = new Set(all.map(bannerKey));
    for (const key of [...this.dismissed]) {
      if (!present.has(key)) this.dismissed.delete(key);
    }
    return all.filter((banner) => !(banner.dismissible && this.dismissed.has(bannerKey(banner))));
  }

  private signIn(): void {
    const provider = this.provider();
    const id = this.state.global.provider?.providerId ?? provider?.id;
    if (id === undefined) return;
    // The provider may know where its program is; the terminal then runs that one.
    this.deps.ui.startSignIn(id, provider?.signInCommand?.());
  }

  // ---- storage ---------------------------------------------------------------------------------------

  private openStore(): Promise<void> {
    this.opening ??= this.doOpenStore().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async doOpenStore(): Promise<void> {
    const dir = this.deps.env.storageDir();
    if (dir === undefined || this.store) return;
    const store = createConversationStore({
      dir: join(dir, 'conversations'),
      logger: this.logger,
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    });
    const plans = createPlanStore({
      dir: join(dir, 'plans'),
      logger: this.logger,
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    });
    await store.init();
    await plans.init();
    await this.recoverInterrupted(store);
    if (!this.deps.policy || !this.deps.observers) await this.createDefaults(dir);
    if (this.projectConfigGate) {
      const decisions = createProjectConfigDecisions({
        dir: join(dir, 'project-config'),
        logger: this.logger,
      });
      await decisions.init();
      this.projectConfigDecisions = decisions;
    }
    this.storageDir = dir;
    this.store = store;
    this.plans = plans;
  }

  /**
   * What the application uses when it is not given a policy or observers: the mode policy over
   * the read-only and agent policies, and the read-only tripwire with the workspace tracker.
   */
  private async createDefaults(dir: string): Promise<void> {
    const { logger } = this.deps;
    if (!this.policy) {
      const rules = createRuleStore({ dir: join(dir, 'rules'), logger });
      await rules.init();
      this.rules = rules;
      const readOnly = createReadOnlyPolicy({ logger });
      this.policy = createModePolicy({
        ask: readOnly,
        plan: readOnly,
        agent: createAgentPolicy({ rules, logger }),
      });
    }
    if (!this.deps.observers) {
      const globalDir = this.deps.env.globalStorageDir();
      const tracker = createWorkspaceTracker({
        storageDir: join(dir, 'workspace'),
        ...(globalDir !== undefined ? { lockDir: join(globalDir, 'locks') } : {}),
        ...(this.deps.editor ? { editor: this.deps.editor } : {}),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
        logger,
        isProcessAlive: isAlive,
        stopProcess: (pid) => stopOrphan(pid),
      });
      this.tracker = tracker;
      const engine = createReviewEngine({
        tracker,
        ...(this.deps.editor ? { editor: this.deps.editor } : {}),
        settings: () => this.deps.env.settings(),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
        logger,
      });
      this.engine = engine;
      const checkpoints = createCheckpointService({
        tracker,
        ...(this.deps.editor ? { editor: this.deps.editor } : {}),
        settings: () => this.deps.env.settings(),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
        logger,
        onDidRestore: (key) => {
          engine.changed(key);
          this.refreshReviewOf(key);
        },
      });
      this.checkpoints = checkpoints;
      this.observers = [
        createReadOnlyTripwire({ logger }),
        tracker.observer,
        engine.observer,
        this.reviewNotice(tracker, engine),
      ];
      this.unsubscribe.push(
        tracker.onDidChangeStatus(() => {
          for (const view of this.state.views.values()) this.syncBaseline(view, false);
        }),
        engine.onDidChange((key) => {
          for (const view of this.state.views.values()) this.syncReviewEntries(view);
          // A review action may have written to the log.
          checkpoints.changed(key);
        }),
        checkpoints.onDidChange(() => this.syncAllCheckpoints()),
        tracker.onDidChangeConfigChanges(() => {
          for (const view of this.state.views.values()) this.syncConfigChanges(view);
        }),
      );
    }
  }

  /**
   * Cleans up after turns that were cut off (once, at start-up) and starts reading the folders so
   * an Agent turn does not have to wait for its baseline.
   */
  get trackerInUse(): WorkspaceTracker | undefined {
    return this.tracker;
  }

  get checkpointsInUse(): CheckpointEngine | undefined {
    return this.checkpoints;
  }

  get rulesInUse(): RuleStore | undefined {
    return this.rules;
  }

  private async startTracker(): Promise<void> {
    const { tracker } = this;
    if (!tracker || this.disposed || !this.deps.env.trusted()) return;
    const settings = this.deps.env.settings();
    // Only the folders open at start-up are checked for a cut-off turn; later ones are just pre-warmed.
    const recover = !this.recoveryDone;
    this.recoveryDone = true;
    for (const folder of this.deps.env.folders()) {
      if (this.prewarmed.has(folder.key)) continue;
      this.prewarmed.add(folder.key);
      if (recover) {
        await this.recoverFolder(tracker, folder, settings);
        this.collectGarbageSoon(folder.key);
      }
      if (this.disposed) return;
      tracker.prewarm(folder, settings);
    }
    for (const view of this.state.views.values()) this.syncViewScope(view);
  }

  private async recoverFolder(
    tracker: WorkspaceTracker,
    folder: FolderInfo,
    settings: ReturnType<AppDeps['env']['settings']>,
    options?: { force?: boolean },
  ): Promise<void> {
    try {
      const result = options?.force
        ? await tracker.recover(folder, settings, { force: true })
        : await tracker.recover(folder, settings);
      this.showRecovery(folder.key, result);
      this.refreshFolderViews(folder.key);
    } catch (error) {
      this.logger.warn('an interrupted turn could not be cleaned up', {
        error: redact(String(error)),
      });
    }
  }

  /**
   * Shows what recovery of a folder came to. A recovery that did not complete stays on screen with a
   * button to finish it by hand; one that did is a note the user can dismiss.
   */
  private showRecovery(
    folderKey: FolderKey,
    result: { recovered: boolean; notes: string[] },
  ): void {
    // Nothing recovered and nothing to say (a turn is open, for instance): leave what is shown.
    if (!result.recovered && result.notes.length === 0) return;
    const ours = (id: string): boolean =>
      id === `recovery:${folderKey}` || id.startsWith(`recovery:${folderKey}:`);
    for (const id of [...this.recoveryBanners.keys()]) {
      if (ours(id)) this.recoveryBanners.delete(id);
    }
    result.notes.forEach((note, position) => {
      const id = position === 0 ? `recovery:${folderKey}` : `recovery:${folderKey}:${position + 1}`;
      this.recoveryBanners.set(id, {
        id,
        level: 'warning',
        text: note,
        ...(result.recovered ? {} : { action: { ...RECOVER_NOW_ACTION } }),
        dismissible: result.recovered,
      });
      if (result.recovered) {
        for (const view of this.state.views.values()) this.state.toast(view, 'warning', note);
      }
    });
    if (result.recovered || result.notes.length === 0) this.unfinishedRecovery.delete(folderKey);
    else this.unfinishedRecovery.add(folderKey);
    this.state.patchGlobal({ banners: this.banners(this.state.global.provider) });
  }

  /** A recovery wrote to the log and the files: every view of the folder looks again. */
  private refreshFolderViews(folderKey: FolderKey): void {
    this.engine?.changed(folderKey);
    this.checkpoints?.changed(folderKey);
    for (const view of this.state.views.values()) {
      if (this.viewFolder(view)?.key !== folderKey) continue;
      this.syncReviewEntries(view);
      this.syncCheckpoints(view);
      this.syncBaseline(view, true);
    }
  }

  /** "Recover now" on a recovery that could not tell whether the old process had stopped. */
  private async recoverNow(folderKey: FolderKey): Promise<void> {
    const { tracker } = this;
    const folder = this.deps.env.folders().find((candidate) => candidate.key === folderKey);
    if (!tracker || !folder) return;
    const confirmed = await this.deps.ui.confirm({
      title: 'Recover the interrupted turn now?',
      detail:
        'Do this only after Claude Code from that turn has stopped. If it is still running, its later changes will not be tracked.',
      confirmLabel: 'Recover Now',
    });
    if (!confirmed || this.disposed) return;
    const settings = this.deps.env.settings();
    await this.recoverFolder(tracker, folder, settings, { force: true });
    tracker.prewarm(folder, settings);
  }

  /** An Agent turn was refused: if the folder is waiting on an unfinished recovery, look again. */
  private turnRefused(folder: FolderInfo, mode: Mode): void {
    const { tracker } = this;
    if (mode !== 'agent' || !tracker || !this.unfinishedRecovery.has(folder.key)) return;
    void this.recoverFolder(tracker, folder, this.deps.env.settings());
  }

  /**
   * A turn that is stored as running or preparing was cut off by a crash or a reload. It is marked
   * interrupted, and what it left open (tool calls, prompts) is closed with it.
   */
  private async recoverInterrupted(store: ConversationStore): Promise<void> {
    for (const meta of store.list()) {
      try {
        const data = await store.load(meta.id);
        if (!data) continue;
        this.pendingPreviews.set(meta.id, previewOf(data.messages));
        const stale = new Set(
          data.turns
            .filter((turn) => turn.status === 'running' || turn.status === 'preparing')
            .map((turn) => turn.id),
        );
        if (stale.size === 0) continue;
        for (const turn of data.turns) {
          if (!stale.has(turn.id)) continue;
          await store.putTurn(meta.id, {
            ...turn,
            status: 'interrupted',
            error: TEXT.closedWhileRunning,
          });
        }
        for (const message of data.messages) {
          if (message.role !== 'assistant' || !stale.has(message.turnId)) continue;
          const open = message.parts.some(
            (part) =>
              part.kind === 'tool' &&
              (part.call.status === 'running' || part.call.status === 'awaiting-approval'),
          );
          if (!open) continue;
          await store.putMessage(meta.id, {
            ...message,
            parts: message.parts.map((part) =>
              part.kind === 'tool' &&
              (part.call.status === 'running' || part.call.status === 'awaiting-approval')
                ? { ...part, call: { ...part.call, status: 'not-run' as const } }
                : part,
            ),
          });
        }
        for (const prompt of data.prompts) {
          if (prompt.state === 'pending' && stale.has(prompt.turnId)) {
            await store.putPrompt(meta.id, { ...prompt, state: 'expired' });
          }
        }
      } catch (error) {
        this.logger.warn('a stored conversation could not be checked at start-up', {
          error: redact(String(error)),
        });
      }
    }
  }

  /**
   * Shows the previews found at start-up a few at a time, so the views can attach first. Stale-turn
   * recovery has to read every stored conversation anyway; this only decides when the result is shown.
   */
  private fillPreviews(): void {
    const entries = [...this.pendingPreviews];
    this.pendingPreviews = new Map();
    if (entries.length === 0) return;
    const step = (): void => {
      if (this.disposed) return;
      const stored = new Set(this.store?.list().map((meta) => meta.id));
      for (const [id, preview] of entries.splice(0, PREVIEW_BATCH)) {
        // A conversation that was opened or has run since has a newer preview already.
        if (stored.has(id) && !this.state.previews.has(id)) this.state.previews.set(id, preview);
      }
      this.state.refreshSummaries();
      if (entries.length > 0) setImmediate(step);
    };
    setImmediate(step);
  }

  private requireStore(view: ViewRecord): ConversationStore | undefined {
    if (!this.store) this.state.toast(view, 'warning', TEXT.noStorage);
    return this.store;
  }

  // ---- views ------------------------------------------------------------------------------------------

  attachView(
    kind: 'sidebar' | 'panel',
    sink: ViewSink,
    initial?: { conversationId?: ConversationId },
  ): ViewHandle {
    this.viewCount += 1;
    const view = new ViewRecord(
      `view-${this.viewCount}`,
      kind,
      sink,
      this.state.newViewState(),
      this.logger,
    );
    this.state.views.set(view.id, view);
    this.syncViewScope(view);
    this.lastUsed ??= view;
    if (initial?.conversationId !== undefined) {
      view.initialConversation = initial.conversationId;
      if (this.loaded) void this.openInitial(view);
    }
    return {
      id: view.id,
      receive: (raw) => this.receive(view, raw),
      dispose: () => this.detachView(view),
    };
  }

  private detachView(view: ViewRecord): void {
    view.dispose();
    this.state.views.delete(view.id);
    if (this.lastUsed === view) this.lastUsed = undefined;
    if (view.activeId !== undefined) this.state.release(view.activeId);
    this.pruneImages();
  }

  private recentView(): ViewRecord | undefined {
    if (this.lastUsed && !this.lastUsed.disposed) return this.lastUsed;
    return this.state.views.values().next().value;
  }

  private async openInitial(view: ViewRecord): Promise<void> {
    const id = view.initialConversation;
    view.initialConversation = undefined;
    if (id === undefined || view.disposed) return;
    try {
      await this.openConversation(view, id);
    } catch (error) {
      this.logger.warn('the first conversation of a view could not be opened', {
        error: redact(String(error)),
      });
    }
  }

  newConversation(): void {
    const view = this.recentView();
    if (!view) return;
    this.startDraft(view, undefined);
    view.event({ kind: 'focus-composer' });
  }

  review(): ReviewEngine | undefined {
    return this.engine;
  }

  addAttachment(attachment: Attachment): void {
    const view = this.recentView();
    if (!view) return;
    this.attach(view, [attachment]);
  }

  // ---- messages from the webview -------------------------------------------------------------------------

  private receive(view: ViewRecord, raw: unknown): void {
    if (this.disposed || view.disposed) return;
    const parsed = WebviewMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('ignored an invalid message from a view', { type: typeOf(raw) });
      return;
    }
    this.lastUsed = view;
    const message = parsed.data;
    this.handle(view, message).catch((error: unknown) => {
      this.logger.error('a message handler failed', {
        type: message.type,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
      this.state.toast(view, 'error', TEXT.handlerFailed);
    });
  }

  /**
   * Every message here comes from a webview that must be treated as untrusted. What can hurt the user
   * is guarded by a native dialog the webview cannot click: approving and running a plan, keeping or
   * reverting a configuration change, rejecting everything, restoring a checkpoint, deleting a
   * conversation or the stored file data, an "always allow" rule, and the project configuration choice.
   *
   * What a compromised webview can still do WITHOUT a native dialog, as the residual risk:
   * - start a turn (`turn.send`), in any mode the policy offers, with text and attachments of its own;
   * - queue one message per conversation behind a turn that runs there (`turn.send` again), and later
   *   send it, take it back for editing or remove it (`queue.*`): no more than `turn.send` allows;
   * - hand the host pasted image data, which is checked (type, size, signature), kept in memory only
   *   while a draft refers to it, and sent with the next message;
   * - answer a permission prompt with "allow once" (the prompt shows what it allows, but the click is
   *   the webview's), and answer questions of the agent;
   * - make plan decisions, lock or unlock a plan, revert a plan to an earlier version;
   * - open a version of a plan as a read-only document (`plan.open`), without a dialog: the text comes
   *   from the stored plan, not from the message;
   * - accept changes (this only records a decision, no file is written);
   * - reject a single file when it is as the agent left it (the checkpoint history can undo it), and
   *   the `agent-only` or `overwrite` choices after a native choice dialog (rejecting a single hunk
   *   exists only in the editor, not in the webview);
   * - copy text to the clipboard, open files inside the workspace folders and links after the editor's
   *   own confirmation;
   * - rename, change the mode and model of, fork and open conversations.
   */
  private async handle(view: ViewRecord, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        view.ready = true;
        view.init();
        return;
      case 'resync':
        if (view.ready) view.init();
        return;

      case 'conversation.new':
        this.closeFileSearch(view);
        this.startDraft(view, message.folder);
        return;
      case 'conversation.open':
        this.closeFileSearch(view);
        await this.openConversation(view, message.conversationId);
        return;
      case 'conversation.rename':
        await this.renameConversation(view, message.conversationId, message.title);
        return;
      case 'conversation.delete':
        await this.deleteConversation(view, message.conversationId);
        return;
      case 'conversation.search':
        await this.searchConversations(view, message.query);
        return;
      case 'conversation.setMode':
        await this.changeConversation(view, message.conversationId, { mode: message.mode });
        return;
      case 'conversation.setModel':
        await this.changeConversation(view, message.conversationId, { model: message.model });
        return;
      case 'conversation.fork':
        await this.forkConversation(view, message.conversationId, message.messageId);
        return;
      case 'conversation.openInEditor':
        this.deps.ui.openEditorPanel(message.conversationId);
        return;

      case 'turn.send':
        this.closeFileSearch(view);
        await this.sendTurn(view, message);
        return;
      case 'turn.cancel':
        await this.runs.get(message.conversationId)?.cancel();
        return;
      case 'queue.edit':
        this.editQueued(view, message.conversationId);
        return;
      case 'queue.remove':
        this.removeQueued(message.conversationId);
        return;
      case 'queue.sendNow':
        await this.sendQueuedNow(view, message.conversationId);
        return;

      case 'context.pick':
        await this.pickContext(view, message.what);
        return;
      case 'context.search':
        await this.searchContext(view, message.query);
        return;
      case 'context.add':
        await this.addContextPath(view, message.path, message.kind);
        return;
      case 'context.addSelection':
        this.addFromEditor(view, 'selection');
        return;
      case 'context.addDiagnostics':
        this.addFromEditor(view, 'diagnostics');
        return;
      case 'context.pasteImage':
        this.pasteImage(view, message.mediaType, message.data);
        return;
      case 'context.remove':
        this.removeAttachment(view, message.attachment);
        return;

      case 'prompt.answer':
        await this.answerPrompt(message.promptId, message.displayHash, message.answer);
        return;

      case 'open.file':
        await this.openFile(view, message.path, message.line);
        return;
      case 'open.link':
        await this.openLink(view, message.url);
        return;
      case 'banner.action':
        await this.bannerAction(message.bannerId, message.actionId);
        return;
      case 'banner.dismiss':
        this.dismissBanner(message.bannerId);
        return;
      case 'clipboard.copy':
        await this.deps.ui.copyToClipboard(message.text);
        return;
      case 'provider.refresh':
        await this.refreshProvider();
        return;
      case 'provider.signIn':
        this.signIn();
        return;
      case 'logs.show':
        this.deps.ui.showLogs();
        return;

      case 'plan.setLocked':
        await this.changeConversation(view, message.conversationId, { planLocked: message.locked });
        return;
      case 'plan.decide':
        await this.decideInPlan(view, message);
        return;
      case 'plan.approve':
        await this.approvePlan(view, message.planId, message.version, message.contentHash);
        return;
      case 'plan.revert':
        await this.revertPlan(view, message.planId, message.version);
        return;
      case 'plan.compare':
        await this.comparePlan(view, message.planId, message.left, message.right);
        return;
      case 'plan.open':
        await this.openPlanVersion(view, message.planId, message.version);
        return;
      case 'review.openDiff':
        await this.openReviewDiff(view, message.path);
        return;
      case 'review.openAll':
        await this.openAllChanges(view);
        return;
      case 'review.acceptAll':
        if (this.acceptRefused(view)) return;
        await this.reviewAction(view, (engine, key) => engine.acceptAll(key));
        return;
      case 'review.acceptFile':
        if (this.acceptRefused(view)) return;
        await this.reviewAction(view, (engine, key) => engine.acceptFile(key, message.path));
        return;
      case 'review.rejectFile':
        await this.rejectFileForView(view, message.path);
        return;
      case 'review.rejectAll':
        await this.rejectAllForView(view, message.includePaths);
        return;

      case 'config.keep':
        await this.resolveConfigChange(view, message.changeId, 'keep');
        return;
      case 'config.revert':
        await this.resolveConfigChange(view, message.changeId, 'revert');
        return;
      case 'config.openDiff':
        await this.openConfigDiff(view, message.changeId);
        return;

      case 'checkpoint.preview':
        await this.previewCheckpoint(view, message.operationId);
        return;
      case 'checkpoint.cancelPreview':
        this.setRestorePreview(view, null);
        return;
      case 'checkpoint.openDiff':
        await this.openCheckpointDiff(view, message.token, message.path);
        return;
      case 'checkpoint.restore':
        await this.restoreCheckpoint(view, message.token, message.paths, message.andFork);
        return;

      default:
        assertNever(message);
    }
  }

  // ---- conversations -------------------------------------------------------------------------------------

  private startDraft(view: ViewRecord, folder: FolderKey | undefined): void {
    view.navigation += 1;
    const known = folder !== undefined && this.deps.env.folders().some((f) => f.key === folder);
    view.draftFolder = known ? folder : undefined;
    this.state.showDraft(view);
  }

  /** A conversation in memory: the one a view or a running turn holds, or one loaded from the store. */
  private getRuntime(id: ConversationId): Promise<ConvRuntime | undefined> {
    const known = this.state.runtimes.get(id);
    if (known) return Promise.resolve(known);
    const pending = this.loading.get(id);
    if (pending) return pending;
    const { store } = this;
    if (!store) return Promise.resolve(undefined);
    const load = store
      .load(id)
      .then(async (data) => {
        if (!data) return undefined;
        const existing = this.state.runtimes.get(id);
        if (existing) return existing;
        const plan = await this.loadPlan(data.meta.planId);
        const raced = this.state.runtimes.get(id);
        if (raced) return raced;
        this.state.previews.set(id, previewOf(data.messages));
        return this.state.addRuntime({
          meta: data.meta,
          turns: data.turns,
          messages: data.messages,
          prompts: data.prompts,
          plan,
          activity: null,
          queued: this.queued.get(id)?.message ?? null,
        });
      })
      .finally(() => {
        this.loading.delete(id);
      });
    this.loading.set(id, load);
    return load;
  }

  private async loadPlan(planId: PlanId | undefined): Promise<PlanDoc | null> {
    if (planId === undefined || !this.plans) return null;
    try {
      return (await this.plans.get(planId)) ?? null;
    } catch (error) {
      this.logger.warn('a plan could not be loaded', { error: redact(String(error)) });
      return null;
    }
  }

  private async openConversation(view: ViewRecord, id: ConversationId): Promise<boolean> {
    if (view.activeId === id) return true;
    const navigation = ++view.navigation;
    const runtime = await this.getRuntime(id);
    if (view.disposed || navigation !== view.navigation) {
      if (runtime) this.state.release(id);
      return false;
    }
    if (!runtime) {
      this.state.toast(view, 'warning', TEXT.openFailed);
      return false;
    }
    this.state.showConversation(view, runtime);
    return true;
  }

  private async renameConversation(
    view: ViewRecord,
    id: ConversationId,
    title: string,
  ): Promise<void> {
    const store = this.requireStore(view);
    const trimmed = title.trim();
    if (!store || trimmed.length === 0) return;
    if (!store.list().some((meta) => meta.id === id)) {
      this.state.toast(view, 'warning', TEXT.conversationGone);
      return;
    }
    await this.updateMeta(store, id, { title: trimmed });
  }

  /** Mode and model cannot change under a running turn. */
  private async changeConversation(
    view: ViewRecord,
    id: ConversationId,
    patch: { mode: ConversationMeta['mode'] } | { model: string } | { planLocked: boolean },
  ): Promise<void> {
    const store = this.requireStore(view);
    if (!store) return;
    if (this.runs.has(id)) {
      this.state.toast(view, 'warning', TEXT.waitForTurn);
      return;
    }
    if (!store.list().some((meta) => meta.id === id)) {
      this.state.toast(view, 'warning', TEXT.conversationGone);
      return;
    }
    await this.updateMeta(store, id, patch);
  }

  private async updateMeta(
    store: ConversationStore,
    id: ConversationId,
    patch: Parameters<ConversationStore['updateMeta']>[1],
  ): Promise<void> {
    const next = await store.updateMeta(id, patch);
    const runtime = this.state.runtimes.get(id);
    if (runtime) this.state.mutate(runtime, [{ op: 'set', path: ['meta'], value: next }]);
    this.state.refreshSummaries();
    this.syncAllCheckpoints();
  }

  private async deleteConversation(view: ViewRecord, id: ConversationId): Promise<void> {
    const store = this.requireStore(view);
    if (!store) return;
    const meta = store.list().find((candidate) => candidate.id === id);
    if (meta) {
      const confirmed = await this.deps.ui.confirm({
        title: 'Delete this conversation?',
        detail: `"${safeText(meta.title)}" and its plan are deleted. Files and the checkpoint history are not affected.`,
        confirmLabel: 'Delete',
      });
      if (!confirmed || view.disposed) return;
    }
    // Nothing may start or be queued in the conversation until it is gone.
    this.reserved.add(id);
    try {
      // Before the turn is stopped: a turn that ends on its own meanwhile must not send it.
      this.queued.delete(id);
      const run = this.runs.get(id);
      if (run) {
        await run.cancel();
        await run.done;
      }
      this.queued.delete(id);
      for (const shown of this.state.views.values()) {
        if (shown.activeId === id) {
          shown.navigation += 1;
          this.state.showDraft(shown);
        }
      }
      const planId = store.list().find((meta) => meta.id === id)?.planId;
      await store.delete(id);
      if (planId !== undefined) await this.deletePlan(planId);
    } finally {
      this.reserved.delete(id);
    }
    this.state.runtimes.delete(id);
    this.state.previews.delete(id);
    this.pruneImages();
    for (const shown of this.state.views.values()) {
      const search = shown.state.search;
      if (!search) continue;
      const results = search.results.filter((hit) => hit.conversationId !== id);
      if (results.length !== search.results.length) {
        shown.apply([{ op: 'set', path: ['search'], value: { ...search, results } }]);
      }
    }
    this.state.refreshSummaries();
    this.syncAllCheckpoints();
  }

  private async deletePlan(planId: PlanId): Promise<void> {
    try {
      await this.plans?.delete(planId);
    } catch (error) {
      this.logger.warn('a plan could not be deleted', { error: redact(String(error)) });
    }
  }

  private async searchConversations(view: ViewRecord, query: string): Promise<void> {
    const token = ++view.searchToken;
    if (query.trim().length === 0) {
      view.apply([{ op: 'set', path: ['search'], value: null }]);
      return;
    }
    const hits = this.store ? await this.store.search(query, MAX_SEARCH_RESULTS) : [];
    if (view.disposed || token !== view.searchToken) return;
    view.apply([{ op: 'set', path: ['search'], value: { query, results: hits } }]);
  }

  private async forkConversation(
    view: ViewRecord,
    parentId: ConversationId,
    atMessageId: Parameters<ConversationStore['fork']>[0]['atMessageId'],
    options: { skipNewerFilesNotice?: boolean } = {},
  ): Promise<void> {
    const store = this.requireStore(view);
    if (!store) return;
    // A copy of the session cannot include a turn that has not ended.
    if (this.runs.has(parentId)) {
      const parent = this.state.runtimes.get(parentId)?.data;
      const target = parent?.messages.find((message) => message.id === atMessageId);
      const running = parent?.turns.find(
        (turn) =>
          turn.id === target?.turnId && (turn.status === 'running' || turn.status === 'preparing'),
      );
      // Branching at the user message of a running turn keeps only the turns before it.
      if (target?.role === 'assistant' && running) {
        this.state.toast(view, 'warning', TEXT.branchWhileRunning);
        return;
      }
    }
    let result: Awaited<ReturnType<ConversationStore['fork']>>;
    try {
      result = await store.fork({ parentId, atMessageId });
    } catch (error) {
      this.logger.warn('a branch could not be created', { error: redact(String(error)) });
      this.state.toast(view, 'warning', TEXT.branchFailed);
      return;
    }
    await this.copyPlanToBranch(parentId, result.meta.id);
    const newerFiles = options.skipNewerFilesNotice
      ? undefined
      : await this.noteNewerFiles(parentId, result.meta.id);
    const opened = await this.openConversation(view, result.meta.id);
    this.state.refreshSummaries();
    if (opened && newerFiles === 'toast') {
      this.state.toast(view, 'info', TEXT.filesNewerThanBranch);
    }
    if (opened && result.prefill !== undefined) {
      // The event must reach the view after the patch that shows the branch.
      view.flush();
      view.event({ kind: 'prefill-composer', text: result.prefill });
    }
  }

  /**
   * Branching does not change files. When turns the branch does not keep changed files in the same
   * folder, the branch says so: as a notice at the end of its kept messages, or, when it keeps none,
   * as a message when it is opened.
   */
  private async noteNewerFiles(
    parentId: ConversationId,
    branchId: ConversationId,
  ): Promise<'noted' | 'toast' | undefined> {
    const { store, tracker } = this;
    if (!store || !tracker) return undefined;
    try {
      const [parent, branch] = await Promise.all([store.load(parentId), store.load(branchId)]);
      if (!parent || !branch) return undefined;
      const later = new Set<string>(parent.turns.slice(branch.turns.length).map((turn) => turn.id));
      if (later.size === 0) return undefined;
      const changed = (tracker.folder(parent.meta.folder)?.log.records() ?? []).some(
        (record) =>
          record.type === 'operation' &&
          record.turnId !== undefined &&
          later.has(record.turnId) &&
          record.changes.length > 0,
      );
      if (!changed) return undefined;
      const last = branch.messages[branch.messages.length - 1];
      if (!last) return 'toast';
      await store.putMessage(branchId, {
        role: 'assistant',
        id: newId<MessageId>(),
        turnId: last.turnId,
        createdAt: (this.deps.clock ?? { now: () => Date.now() }).now(),
        parts: [{ kind: 'notice', level: 'info', text: TEXT.filesNewerThanBranch }],
      });
      return 'noted';
    } catch (error) {
      this.logger.warn('the files of a branch could not be compared', {
        error: redact(String(error)),
      });
      return undefined;
    }
  }

  /** A branch gets its own copy of the plan of the conversation it came from. */
  private async copyPlanToBranch(
    parentId: ConversationId,
    branchId: ConversationId,
  ): Promise<void> {
    const planId = this.store?.list().find((meta) => meta.id === parentId)?.planId;
    if (planId === undefined || !this.plans || !this.store) return;
    try {
      // The plan as it stood at the fork point. A branch that keeps no turn has no plan; one that
      // keeps every turn gets all of it; otherwise it is cut by the time the last kept turn ended.
      const [branch, parent] = await Promise.all([
        this.store.load(branchId),
        this.store.load(parentId),
      ]);
      const lastKept = branch?.meta.fork?.lastKeptParentTurnId;
      if (lastKept === undefined || !parent) return;
      const keptTurn = parent.turns.find((turn) => turn.id === lastKept);
      if (!keptTurn) return;
      const wholePlan = parent.turns[parent.turns.length - 1]?.id === lastKept;
      const copy = await this.plans.copy(
        planId,
        branchId,
        wholePlan ? {} : { upToTime: keptTurn.endedAt ?? keptTurn.startedAt },
      );
      if (!copy) return;
      await this.store.updateMeta(branchId, { planId: copy.id });
      // The copied messages still name the parent's plan; point their plan cards at the copy.
      for (const message of branch?.messages ?? []) {
        if (message.role !== 'assistant') continue;
        if (!message.parts.some((part) => part.kind === 'plan-update')) continue;
        await this.store.putMessage(branchId, {
          ...message,
          parts: message.parts.map((part) =>
            part.kind === 'plan-update' ? { ...part, planId: copy.id } : part,
          ),
        });
      }
    } catch (error) {
      this.logger.warn('the plan could not be copied to the branch', {
        error: redact(String(error)),
      });
    }
  }

  // ---- turns ---------------------------------------------------------------------------------------------

  /**
   * Starts a turn for a message. Resolves to whether a run has started; a refusal says why in a toast
   * (logged instead when no view is given: a queued message is sent without any view attached).
   */
  private async sendTurn(
    view: ViewRecord | undefined,
    message: SendMessage,
    options: TurnOptions = {},
  ): Promise<boolean> {
    const { env } = this.deps;
    const refuse = (text: string): false => {
      if (view) this.state.toast(view, 'warning', text);
      else this.logger.info('a queued message was not sent', { reason: text });
      return false;
    };
    let runtime: ConvRuntime | undefined;
    const giveUp = (text: string): false => {
      if (runtime) this.state.release(runtime.id);
      return refuse(text);
    };

    if (!env.trusted()) return refuse(TEXT.untrustedRefusal);
    const folders = env.folders();
    if (folders.length === 0) return refuse(TEXT.noFolder);
    const { store } = this;
    const storageDir = this.storageDir;
    const plans = this.plans;
    const { policy } = this;
    if (!store || !plans || !policy || storageDir === undefined) return refuse(TEXT.noStorage);
    const provider = this.provider();
    if (!provider) return refuse(TEXT.noProvider);
    const status = this.state.global.provider;
    if (!status) return refuse(TEXT.checkingProvider);
    if (!status.installed) return refuse(claudeNotInstalled(status.displayName));
    if (!status.meetsMinimum) return refuse(claudeTooOld(status.displayName));
    if (status.auth === 'signed-out') return refuse(claudeSignedOut(status.displayName));

    if (message.conversationId !== undefined) {
      runtime = await this.getRuntime(message.conversationId);
      if (!runtime) return refuse(TEXT.conversationGone);
    }
    if (this.disposed) return false;
    if (view?.creating || (runtime && this.isBusy(runtime.id))) {
      // A turn runs in the conversation and nothing else holds it: Agent and Plan messages wait for it.
      if (
        view &&
        runtime &&
        !view.creating &&
        !options.gate &&
        !options.queuedInput &&
        message.mode !== 'ask' &&
        this.runs.has(runtime.id) &&
        !this.reserved.has(runtime.id) &&
        (this.forkHolds.get(runtime.id) ?? 0) === 0
      ) {
        return this.queueMessage(view, runtime, message);
      }
      return giveUp(TEXT.turnRunning);
    }

    const settings = env.settings();
    const existing = runtime;
    const folder = existing
      ? folders.find((candidate) => candidate.key === existing.data.meta.folder)
      : (folders.find((candidate) => candidate.key === view?.draftFolder) ?? folders[0]);
    let conversation: ConversationMeta;
    if (existing) {
      conversation = existing.data.meta;
    } else if (folder) {
      const now = (this.deps.clock ?? { now: () => Date.now() }).now();
      // Not stored: the policy needs something to look at before the conversation exists.
      conversation = {
        id: newId<ConversationId>(),
        title: titleOf(message.text) ?? '',
        createdAt: now,
        updatedAt: now,
        folder: folder.key,
        providerId: provider.id,
        model: message.model,
        mode: message.mode,
        planLocked: false,
      };
    } else {
      return refuse(TEXT.noFolder);
    }
    const profile = policy.profile({ mode: message.mode, settings, conversation });
    if ('unavailable' in profile) return giveUp(profile.unavailable);
    if (!folder) return giveUp(TEXT.conversationFolderClosed);
    if (runtime && runtime.data.meta.providerId !== provider.id) return giveUp(TEXT.noProvider);
    // Before the gate and before anything is stored: an Agent turn would be refused by the tracker
    // anyway, and a plan approval must not be recorded for a turn that cannot start.
    if (message.mode === 'agent' && (this.tracker?.configChanges(folder.key).length ?? 0) > 0) {
      return giveUp(CONFIG_PENDING_MESSAGE);
    }

    let promptText: string | undefined;
    if (options.gate) {
      // Nothing else may start a turn here while the gate asks the user.
      const held = runtime?.id;
      if (held !== undefined) this.reserved.add(held);
      let outcome: Awaited<ReturnType<NonNullable<TurnOptions['gate']>>>;
      try {
        outcome = await options.gate();
      } finally {
        if (held !== undefined) this.reserved.delete(held);
      }
      if (outcome === false || this.disposed) {
        if (runtime) this.state.release(runtime.id);
        return false;
      }
      promptText = outcome.promptText;
    }

    const creating = runtime === undefined;
    if (!runtime) {
      if (!view) return refuse(TEXT.conversationGone);
      view.creating = true;
      try {
        const title = titleOf(message.text);
        const meta = await store.create({
          folder: folder.key,
          providerId: provider.id,
          model: message.model,
          mode: message.mode,
          ...(title !== undefined ? { title } : {}),
        });
        if (this.disposed) return false;
        runtime = this.state.addRuntime({
          meta,
          turns: [],
          messages: [],
          prompts: [],
          plan: null,
          activity: null,
          queued: null,
        });
      } finally {
        view.creating = false;
      }
    }

    // The sending view's attachments go into the message. They are taken before the view shows the
    // new conversation, which would clear them.
    const fromDraft = !options.queuedInput && !options.noAttachments && view !== undefined;
    const taken = options.queuedInput
      ? [...options.queuedInput.attachments]
      : fromDraft
        ? [...view.state.draftAttachments]
        : [];
    // Images travel as bytes: look them up now, before the draft is cleared. One whose bytes are gone
    // is left out of the message.
    const { attachments, images } = this.resolveAttachments(taken, refuse);
    if (fromDraft && taken.length > 0) {
      view.apply([{ op: 'set', path: ['draftAttachments'], value: [] }]);
    }
    this.pruneImages();
    if (creating && view && view.activeId === undefined) this.state.showConversation(view, runtime);

    const run = new TurnRun(this.turnServices(store, plans, policy, storageDir), {
      runtime,
      provider,
      folder,
      profile,
      settings,
      text: message.text,
      ...(promptText !== undefined ? { promptText } : {}),
      mode: message.mode,
      model: message.model,
      attachments,
      ...(images.length > 0 ? { images } : {}),
    });
    this.runs.set(runtime.id, run);
    this.syncReviewBusyAll();
    this.fireRunningChanged();
    run.start();
    options.onStarted?.(run);
    return true;
  }

  /** Splits attachments into what the message lists and the bytes of its images; one with no bytes is left out. */
  private resolveAttachments(
    taken: readonly Attachment[],
    refuse: (text: string) => void,
  ): { attachments: Attachment[]; images: TurnImage[] } {
    const images: TurnImage[] = [];
    const attachments: Attachment[] = [];
    for (const attachment of taken) {
      if (attachment.kind !== 'image') {
        attachments.push(attachment);
        continue;
      }
      const bytes = this.imageBytes.get(attachment.id);
      if (bytes) {
        images.push({ mediaType: attachment.mediaType, data: new Uint8Array(bytes) });
        attachments.push(attachment);
      } else {
        this.logger.warn('an attached image was no longer available');
        refuse(TEXT.imageGone);
      }
    }
    return { attachments, images };
  }

  private turnServices(
    store: ConversationStore,
    plans: PlanStore,
    policy: TurnPolicy,
    storageDir: string,
  ): TurnServices {
    return {
      deps: this.deps,
      policy,
      observers: this.observers,
      state: this.state,
      store,
      plans,
      storageDir,
      prompts: this.prompts,
      refreshProvider: () => this.refreshProvider(),
      onRefused: (folder, mode) => this.turnRefused(folder, mode),
      ...(this.projectConfigDecisions
        ? { resolveProjectConfig: (folder: FolderInfo) => this.resolveProjectConfig(folder) }
        : {}),
      onAlwaysAllowChosen: (conversationId, folderKey, rule) =>
        this.checkAlwaysRule(conversationId, folderKey, rule),
      forkParent: (id) => this.forkParent(id),
      ...(this.engine
        ? {
            revertedSinceLastTurn: async (key: FolderKey) =>
              (await this.engine?.revertedSinceLastTurn(key)) ?? [],
          }
        : {}),
      onEnded: (run) => {
        const status = this.state.runtimes
          .get(run.conversationId)
          ?.data.turns.find((turn) => turn.id === run.turnId)?.status;
        this.collectGarbageSoon(run.folderKey);
        this.runs.delete(run.conversationId);
        this.syncReviewBusyAll();
        // A turn may have created or removed files.
        this.fileSearch.invalidate();
        this.state.running.delete(run.conversationId);
        this.state.refreshSummaries();
        this.state.release(run.conversationId);
        this.fireRunningChanged();
        // Only after a turn that completed: after a stop or an error the message waits for the user.
        if (status === 'completed') {
          this.dispatchQueued(run.conversationId).catch((error: unknown) => {
            this.logger.error('a queued message could not be sent', {
              error: redact(String(error)),
            });
          });
        }
      },
    };
  }

  // ---- the message queued behind a running turn --------------------------------------------------------

  /**
   * Holds the message of a send that came while a turn runs in the conversation. Nothing is stored
   * and no toast is shown. Resolves to false: no run has started.
   */
  private queueMessage(view: ViewRecord, runtime: ConvRuntime, message: SendMessage): false {
    const id = runtime.id;
    if (this.queued.has(id)) {
      // The draft stays as it is.
      this.state.toast(view, 'warning', TEXT.messageAlreadyQueued);
      return false;
    }
    const taken = [...view.state.draftAttachments];
    // The bytes of images stay held in `imageBytes`, which the queued message now refers to.
    const { attachments } = this.resolveAttachments(taken, (text) =>
      this.state.toast(view, 'warning', text),
    );
    const entry: QueuedEntry = {
      message: {
        text: message.text,
        mode: message.mode,
        model: message.model,
        attachments,
        queuedAt: (this.deps.clock ?? { now: () => Date.now() }).now(),
      },
      viewId: view.id,
      sending: false,
    };
    this.queued.set(id, entry);
    if (taken.length > 0) {
      view.apply([{ op: 'set', path: ['draftAttachments'], value: [] }]);
    }
    this.pruneImages();
    this.showQueued(id, entry.message);
    return false;
  }

  /** Shows the queued message of a conversation (or none) in every view that shows it. */
  private showQueued(id: ConversationId, message: QueuedMessage | null): void {
    const runtime = this.state.runtimes.get(id);
    if (runtime) this.state.mutate(runtime, [{ op: 'set', path: ['queued'], value: message }]);
  }

  /**
   * The view a queued message is reported in: the one that queued it while it still shows the
   * conversation, else one that shows it. A view that moved on is not told about it.
   */
  private viewForQueued(id: ConversationId, entry: QueuedEntry): ViewRecord | undefined {
    const queuedBy = this.state.views.get(entry.viewId);
    if (queuedBy && !queuedBy.disposed && queuedBy.activeId === id) return queuedBy;
    for (const candidate of this.state.views.values()) {
      if (candidate.activeId === id) return candidate;
    }
    return undefined;
  }

  /**
   * Sends the queued message of a conversation through `sendTurn`. Safe to call from anywhere and
   * more than once: whoever gets there first marks it as being sent. When the conversation is busy
   * or an Agent message meets pending configuration changes it stays queued, and `by` (an explicit
   * Send) is told why. When no run starts it stays queued.
   */
  private async dispatchQueued(
    id: ConversationId,
    by?: ViewRecord,
    expected?: QueuedEntry,
  ): Promise<void> {
    const entry = this.queued.get(id);
    if (!entry || entry.sending || this.disposed) return;
    if (expected !== undefined && entry !== expected) return;
    const meta =
      this.state.runtimes.get(id)?.data.meta ?? this.store?.list().find((item) => item.id === id);
    let reason: string | undefined;
    if (this.isBusy(id)) {
      reason = TEXT.turnRunning;
    } else if (
      entry.message.mode === 'agent' &&
      meta !== undefined &&
      this.agentRunningIn(meta.folder)
    ) {
      // The tracker would refuse the turn after it was created: keep the message for the user's Send.
      reason = BUSY_MESSAGE;
    } else if (
      entry.message.mode === 'agent' &&
      meta !== undefined &&
      (this.tracker?.configChanges(meta.folder).length ?? 0) > 0
    ) {
      reason = CONFIG_PENDING_MESSAGE;
    }
    if (reason !== undefined) {
      if (by) this.state.toast(by, 'warning', reason);
      return;
    }
    // Synchronously, before any await.
    entry.sending = true;
    let started = false;
    try {
      started = await this.sendTurn(
        by ?? this.viewForQueued(id, entry),
        {
          type: 'turn.send',
          conversationId: id,
          text: entry.message.text,
          mode: entry.message.mode,
          model: entry.message.model,
        },
        { queuedInput: { attachments: entry.message.attachments } },
      );
    } catch (error) {
      this.logger.error('a queued message could not be sent', { error: redact(String(error)) });
    } finally {
      entry.sending = false;
    }
    if (started && this.queued.get(id) === entry) {
      this.queued.delete(id);
      this.showQueued(id, null);
      this.pruneImages();
    }
  }

  /** "Send now": a turn that runs is stopped and waited for first. */
  private async sendQueuedNow(view: ViewRecord, id: ConversationId): Promise<void> {
    const entry = this.queued.get(id);
    if (!entry || this.sendingNow.has(id)) return;
    this.sendingNow.add(id);
    try {
      const run = this.runs.get(id);
      if (run) {
        await run.cancel();
        await run.done;
      }
      await this.dispatchQueued(id, view, entry);
    } finally {
      this.sendingNow.delete(id);
    }
  }

  private removeQueued(id: ConversationId): void {
    const entry = this.queued.get(id);
    if (!entry || entry.sending) return;
    this.queued.delete(id);
    this.showQueued(id, null);
    this.pruneImages();
  }

  /**
   * Takes the message back into the composer of the view that asked: its attachments return to that
   * view's draft, under the limits of a paste, and the host sends the text back. A view that does not
   * show the conversation changes nothing.
   */
  private editQueued(view: ViewRecord, id: ConversationId): void {
    if (view.activeId !== id) return;
    const entry = this.queued.get(id);
    if (!entry || entry.sending) return;
    this.queued.delete(id);
    this.showQueued(id, null);
    this.restoreAttachments(view, entry.message.attachments);
    this.pruneImages();
    // The event must reach the view after the patches that change its draft.
    view.flush();
    view.event({ kind: 'prefill-composer', text: entry.message.text });
  }

  /** Puts attachments back into a draft; an image that would break the limits of a paste is left out. */
  private restoreAttachments(view: ViewRecord, attachments: readonly Attachment[]): void {
    const additions: Attachment[] = [];
    let count = 0;
    let total = 0;
    const held = new Set<string>();
    for (const attachment of view.state.draftAttachments) {
      if (attachment.kind !== 'image') continue;
      count += 1;
      total += attachment.bytes;
      held.add(attachment.id);
    }
    for (const attachment of attachments) {
      if (attachment.kind !== 'image') {
        additions.push(attachment);
      } else if (!held.has(attachment.id)) {
        if (count >= MAX_IMAGES_PER_MESSAGE) {
          this.state.toast(view, 'warning', TEXT.imageLimit);
          continue;
        }
        if (total + attachment.bytes > MAX_IMAGE_BYTES_PER_MESSAGE) {
          this.state.toast(view, 'warning', TEXT.imagesTooLarge);
          continue;
        }
        held.add(attachment.id);
        count += 1;
        total += attachment.bytes;
        additions.push(attachment);
      }
    }
    this.attach(view, additions);
  }

  /** A turn runs in the conversation, or one is about to start (a plan was approved, a session is being copied). */
  private isBusy(id: ConversationId): boolean {
    return this.runs.has(id) || this.reserved.has(id) || (this.forkHolds.get(id) ?? 0) > 0;
  }

  /**
   * What a branch needs to know about its parent. When no turn runs in the parent, nothing may
   * start in it until `release` is called, so the copy of its session is of what was described here.
   */
  private async forkParent(id: ConversationId) {
    const store = this.store;
    if (!store) return undefined;
    const runtime = this.state.runtimes.get(id);
    const meta = runtime?.data.meta ?? store.list().find((candidate) => candidate.id === id);
    if (!meta) return undefined;
    if (this.runs.has(id) || this.reserved.has(id)) {
      return { meta, turns: [], running: true, release: () => undefined };
    }
    this.forkHolds.set(id, (this.forkHolds.get(id) ?? 0) + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (this.forkHolds.get(id) ?? 1) - 1;
      if (left <= 0) this.forkHolds.delete(id);
      else this.forkHolds.set(id, left);
    };
    try {
      const turns = this.state.runtimes.get(id)?.data.turns ?? (await store.load(id))?.turns;
      if (!turns) {
        release();
        return undefined;
      }
      return {
        meta: this.state.runtimes.get(id)?.data.meta ?? meta,
        turns: turns.map((turn) => ({
          id: turn.id,
          ...(turn.forkPointEventId !== undefined
            ? { forkPointEventId: turn.forkPointEventId }
            : {}),
        })),
        running: false,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  // ---- baseline and configuration changes ----------------------------------------------------------

  /** The folder whose baseline and configuration changes a view shows. */
  private viewFolder(view: ViewRecord): FolderInfo | undefined {
    return this.contextFolder(view);
  }

  /** What a view shows about its folder: called whenever the folder it shows may have changed. */
  private syncViewScope(view: ViewRecord): void {
    this.syncBaseline(view, true);
    this.syncConfigChanges(view);
    this.syncReviewBusy(view);
    this.syncReviewEntries(view);
    this.syncCheckpoints(view);
  }

  /** The baseline status of the view's folder. Frequent changes are held back to a few patches a second. */
  private syncBaseline(view: ViewRecord, immediately: boolean): void {
    if (view.disposed) return;
    const folder = this.viewFolder(view);
    const next = (folder ? this.tracker?.status(folder.key) : undefined) ?? IDLE_BASELINE;
    if (canonicalJson(next) === canonicalJson(view.state.baseline)) return;
    const wait = view.baselineAt + BASELINE_MIN_INTERVAL_MS - Date.now();
    if (immediately || wait <= 0) {
      view.baselineAt = Date.now();
      view.apply([{ op: 'set', path: ['baseline'], value: next }]);
      return;
    }
    view.baselineTimer ??= setTimeout(() => {
      view.baselineTimer = undefined;
      this.syncBaseline(view, false);
    }, wait);
  }

  private syncConfigChanges(view: ViewRecord): void {
    if (view.disposed) return;
    const folder = this.viewFolder(view);
    const next = (folder ? this.tracker?.configChanges(folder.key) : undefined) ?? [];
    if (canonicalJson(next) === canonicalJson(view.state.review.configChanges)) return;
    view.apply([{ op: 'set', path: ['review', 'configChanges'], value: next }]);
  }

  /** The tracker, the folder and the pending change a configuration message is about. */
  private configTarget(view: ViewRecord, changeId: string) {
    const folder = this.viewFolder(view);
    if (!this.tracker || !folder) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return undefined;
    }
    const change = this.tracker.configChanges(folder.key).find((item) => item.id === changeId);
    if (!change) {
      this.state.toast(view, 'warning', TEXT.configChangeGone);
      return undefined;
    }
    return { tracker: this.tracker, folder, change };
  }

  private async resolveConfigChange(
    view: ViewRecord,
    changeId: string,
    decision: 'keep' | 'revert',
  ): Promise<void> {
    const target = this.configTarget(view, changeId);
    if (!target) return;
    // Either choice is final: keeping drops the only copy of the earlier file and lifts the block.
    const confirmed = await this.deps.ui.confirm(
      decision === 'revert'
        ? {
            title: 'Revert this configuration change?',
            detail: `${safeText(target.change.displayPath)} goes back to what it was before the turn.`,
            confirmLabel: 'Revert',
          }
        : {
            title: 'Keep this configuration change?',
            detail: `${safeText(target.change.displayPath)} stays as the turn left it. Its earlier version can then no longer be restored from here, and Agent turns are allowed again.`,
            confirmLabel: 'Keep Change',
          },
    );
    if (!confirmed) return;
    try {
      await target.tracker.resolveConfigChange(target.folder.key, changeId, decision);
    } catch (error) {
      this.logger.info('a configuration change could not be resolved', {
        error: redact(String(error)),
      });
      this.state.toast(
        view,
        'warning',
        error instanceof Error ? error.message : TEXT.handlerFailed,
      );
    }
  }

  private async openConfigDiff(view: ViewRecord, changeId: string): Promise<void> {
    const target = this.configTarget(view, changeId);
    if (!target) return;
    const texts = await target.tracker.configChangeTexts(target.folder.key, changeId);
    if (!texts) {
      this.state.toast(view, 'warning', TEXT.configTextsGone);
      return;
    }
    await this.deps.ui.showDiff({
      title: `${target.change.displayPath} (before ↔ after the turn)`,
      leftLabel: 'Before',
      leftText: texts.before,
      rightLabel: 'After',
      rightText: texts.after,
    });
  }

  // ---- checkpoints ----------------------------------------------------------------------------------

  /** The checkpoints of the view's folder, with the titles of the conversations they belong to. */
  private syncCheckpoints(view: ViewRecord): void {
    const { checkpoints } = this;
    if (!checkpoints || view.disposed) return;
    const token = ++view.checkpointToken;
    const folder = this.viewFolder(view);
    void (async () => {
      let list: CheckpointSummary[] = [];
      if (folder) {
        const titles = new Map(this.store?.list().map((meta) => [meta.id, meta.title]));
        list = (await checkpoints.list(folder.key)).map((item) => {
          const title =
            item.conversationId === undefined ? undefined : titles.get(item.conversationId);
          const { conversationTitle: ignored, ...rest } = item;
          void ignored;
          return title === undefined ? rest : { ...rest, conversationTitle: title };
        });
      }
      if (view.disposed || token !== view.checkpointToken) return;
      if (canonicalJson(list) === canonicalJson(view.state.checkpoints)) return;
      view.apply([{ op: 'set', path: ['checkpoints'], value: list }]);
    })().catch((error: unknown) => {
      this.logger.warn('the checkpoints could not be read', { error: redact(String(error)) });
    });
  }

  private syncAllCheckpoints(): void {
    for (const view of this.state.views.values()) this.syncCheckpoints(view);
  }

  private setRestorePreview(view: ViewRecord, preview: RestorePreview | null): void {
    if (canonicalJson(preview) === canonicalJson(view.state.restorePreview)) return;
    view.apply([{ op: 'set', path: ['restorePreview'], value: preview }]);
  }

  /** The service and folder a checkpoint message is about. Without them the feature is not there. */
  private checkpointTarget(
    view: ViewRecord,
  ): { service: CheckpointEngine; folder: FolderInfo } | undefined {
    const folder = this.viewFolder(view);
    if (!this.checkpoints || !folder) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return undefined;
    }
    return { service: this.checkpoints, folder };
  }

  /** Where a view is now: an answer that comes back after it moved on belongs to nobody. */
  private scopeOf(view: ViewRecord): { navigation: number; folder: FolderKey | undefined } {
    return { navigation: view.navigation, folder: this.viewFolder(view)?.key };
  }

  private stillIn(view: ViewRecord, scope: { navigation: number; folder: FolderKey | undefined }) {
    return (
      !view.disposed &&
      view.navigation === scope.navigation &&
      this.viewFolder(view)?.key === scope.folder
    );
  }

  private async previewCheckpoint(view: ViewRecord, operationId: OperationId): Promise<void> {
    const target = this.checkpointTarget(view);
    if (!target) return;
    const scope = this.scopeOf(view);
    try {
      const preview = await target.service.preview(target.folder.key, operationId);
      if (!this.stillIn(view, scope)) return;
      if ('refused' in preview) {
        this.state.toast(view, 'warning', preview.refused);
        return;
      }
      this.setRestorePreview(view, preview);
    } catch (error) {
      this.logger.warn('a checkpoint could not be previewed', { error: redact(String(error)) });
      this.state.toast(view, 'warning', TEXT.handlerFailed);
    }
  }

  private async openCheckpointDiff(view: ViewRecord, token: string, path: RelPath): Promise<void> {
    const target = this.checkpointTarget(view);
    if (!target) return;
    const preview = view.state.restorePreview;
    if (!preview || preview.token !== token) {
      this.state.toast(view, 'warning', TEXT.previewStale);
      return;
    }
    const texts = await target.service.itemTexts(
      target.folder.key,
      preview.targetOperationId,
      token,
      path,
    );
    if (!texts) {
      this.state.toast(view, 'warning', TEXT.checkpointNotText);
      return;
    }
    await this.deps.ui.showDiff({
      title: `${path} (now ↔ after restore)`,
      leftLabel: 'Now',
      leftText: texts.current,
      rightLabel: 'After Restore',
      rightText: texts.target,
    });
  }

  private async restoreCheckpoint(
    view: ViewRecord,
    token: string,
    requested: RelPath[],
    andFork: boolean,
  ): Promise<void> {
    const target = this.checkpointTarget(view);
    if (!target) return;
    // The view's own preview is the only one it may restore from.
    const preview = view.state.restorePreview;
    if (!preview || preview.token !== token) {
      this.state.toast(view, 'warning', TEXT.previewStale);
      return;
    }
    const paths = [...new Set(requested)];
    const chosen = preview.items.filter((item) => paths.includes(item.path));
    if (
      paths.length === 0 ||
      chosen.length !== paths.length ||
      chosen.some((item) => !item.selectable)
    ) {
      this.state.toast(view, 'warning', TEXT.notSelectable);
      return;
    }
    const { service, folder } = target;
    const scope = this.scopeOf(view);
    const operation =
      preview.affectedOperations.find((item) => item.operationId === preview.targetOperationId) ??
      view.state.checkpoints.find((item) => item.operationId === preview.targetOperationId);
    const conflicts = chosen.filter((item) => item.conflict !== undefined).length;
    const count = paths.length;
    const confirmed = await this.deps.ui.confirm({
      title: `Restore ${count} ${count === 1 ? 'file' : 'files'}?`,
      detail:
        `They go back to what they were before ${operation ? checkpointLabel(operation) : 'that checkpoint'}. ` +
        (conflicts > 0
          ? `${conflicts} of them contain changes that were not the agent's, which will be discarded. `
          : '') +
        'You can undo this from the checkpoint history.',
      confirmLabel: 'Restore Files',
    });
    if (!confirmed || !this.stillIn(view, scope)) return;

    let outcome: Awaited<ReturnType<CheckpointEngine['restore']>>;
    try {
      outcome = await service.restore(folder.key, preview.targetOperationId, token, paths);
    } catch (error) {
      this.logger.warn('a checkpoint could not be restored', { error: redact(String(error)) });
      this.state.toast(view, 'warning', TEXT.handlerFailed);
      return;
    }
    if ('refused' in outcome) {
      this.state.toast(view, 'warning', outcome.refused);
      // The folder may have changed: show what the restore would do now.
      const again = await service.preview(folder.key, preview.targetOperationId);
      if (this.stillIn(view, scope))
        this.setRestorePreview(view, 'refused' in again ? null : again);
      return;
    }
    // The restore wrote to the log and to the files: whoever shows them has to look again.
    this.engine?.changed(folder.key);
    this.refreshReviewOf(folder.key);
    if (this.stillIn(view, scope)) this.setRestorePreview(view, null);
    const done = new Set(outcome.items.filter((item) => item.achieved).map((item) => item.path));
    const achieved = done.size;
    const total = outcome.items.length;
    const noun = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;
    this.state.toast(
      view,
      achieved === total ? 'info' : 'warning',
      achieved === total
        ? `Restored ${noun(achieved)}.`
        : `Restored ${achieved} of ${noun(total)}. See the checkpoint history for details.`,
    );
    if (!andFork) return;
    if (achieved === 0 || !paths.every((path) => done.has(path))) {
      // Branching would suggest the files are back as they were: stay where the user is.
      const failures = outcome.items
        .filter((item) => !item.achieved)
        .slice(0, 3)
        .map((item) => `${item.path}: ${item.detail ?? 'it was not restored'}`);
      this.state.toast(
        view,
        'warning',
        `No branch was created because not every file was restored. ${failures.join(' ')}`.trim(),
      );
      return;
    }
    await this.forkAtCheckpoint(view, operation);
  }

  /** "Restore and branch": the conversation goes back to the message that started the turn. */
  private async forkAtCheckpoint(
    view: ViewRecord,
    operation: CheckpointSummary | undefined,
  ): Promise<void> {
    const { store } = this;
    let message: MessageId | undefined;
    if (store && operation?.conversationId !== undefined && operation.turnId !== undefined) {
      const turnId = operation.turnId;
      const data = await store.load(operation.conversationId).catch(() => undefined);
      message = data?.messages.find((item) => item.role === 'user' && item.turnId === turnId)?.id;
    }
    if (!operation?.conversationId || message === undefined) {
      this.state.toast(view, 'warning', TEXT.restoredWithoutBranch);
      return;
    }
    // The files are exactly as they were before that turn, so there is nothing newer to warn about.
    await this.forkConversation(view, operation.conversationId, message, {
      skipNewerFilesNotice: true,
    });
  }

  /**
   * What the project's own Claude Code configuration may do in a turn. It can run programs and change
   * the environment with no prompt, so the user decides once per folder, pinned to the files' content.
   */
  private async resolveProjectConfig(
    folder: FolderInfo,
  ): Promise<{ choice: ProjectConfigChoice; notice?: string } | undefined> {
    const decisions = this.projectConfigDecisions;
    if (!decisions) return undefined;
    const git = await findGit(folder.path).catch(() => undefined);
    const found = await inspectProjectConfig(folder.path, git ? { gitRoot: git.root } : {});
    const use: ProjectConfigChoice = { settings: 'use', mcp: 'use' };
    if (!found.needsSettingsDecision && !found.needsMcpDecision) return { choice: use };

    let decision = decisions.get(folder.key, found.fingerprint);
    if (decision === undefined) {
      const answer = await this.deps.ui.choose({
        title: 'This project configures Claude Code to run programs',
        detail:
          `${safeText(folder.name)}:\n${found.items.map((item) => safeText(item)).join('\n')}\n\n` +
          'Use them only if you trust this repository.' +
          (found.hasClaudeMd && found.needsSettingsDecision
            ? "\nIgnoring them also skips the project's CLAUDE.md instructions."
            : ''),
        options: [
          { id: 'ignore', label: 'Ignore Project Settings' },
          { id: 'use', label: 'Use Project Settings' },
        ],
      });
      if (answer === 'use' || answer === 'ignore') {
        decision = answer;
        await decisions.set(folder.key, found.fingerprint, answer);
      } else {
        // Dismissed: this turn ignores the project's configuration, and nothing is remembered.
        decision = 'ignore';
      }
    }
    if (decision === 'use') return { choice: use };
    const choice: ProjectConfigChoice = {
      settings: found.needsSettingsDecision ? 'ignore' : 'use',
      mcp: found.needsMcpDecision ? 'ignore' : 'use',
    };
    const key = `${folder.key}\u0000${found.fingerprint}`;
    if (this.projectConfigAnnounced.has(key)) return { choice };
    this.projectConfigAnnounced.add(key);
    return { choice, notice: TEXT.projectConfigIgnored };
  }

  async resetProjectConfigDecision(folderKey: FolderKey): Promise<void> {
    const report = this.reportToFolder(folderKey);
    const decisions = this.projectConfigDecisions;
    if (!decisions) {
      report('info', TEXT.notAvailableYet);
      return;
    }
    await decisions.reset(folderKey);
    for (const key of [...this.projectConfigAnnounced]) {
      if (key.startsWith(`${folderKey}\u0000`)) this.projectConfigAnnounced.delete(key);
    }
    report('info', TEXT.projectConfigReset);
  }

  /**
   * The user chose "always allow" for a command. The policy stores the rule, but it only logs when it
   * cannot: so the application checks the rule store itself and tells the user.
   */
  private checkAlwaysRule(
    conversationId: ConversationId,
    folderKey: FolderKey,
    rule: string,
  ): void {
    const { rules } = this;
    if (!rules || rules.list(folderKey).includes(rule)) return;
    this.state.toastConversation(conversationId, 'warning', TEXT.ruleNotSaved);
  }

  /** Deletes what the review and the checkpoints keep for a folder, after the user has confirmed. */
  async purgeStoredFileData(folderKey: FolderKey): Promise<void> {
    const report = this.reportToFolder(folderKey);
    const { tracker } = this;
    const folder = this.deps.env.folders().find((candidate) => candidate.key === folderKey);
    if (!tracker || !folder) {
      report('info', TEXT.notAvailableYet);
      return;
    }
    const confirmed = await this.deps.ui.confirm({
      title: 'Delete stored file contents and change history?',
      detail: `For ${safeText(folder.name)}: the file contents AgentCanopy captured, the list of pending agent changes and the checkpoint history are deleted. Files in the folder are not touched, and conversations and plans are kept. This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!confirmed || this.disposed) return;
    try {
      await tracker.purge(folderKey);
    } catch (error) {
      this.logger.info('stored file data could not be deleted', { error: redact(String(error)) });
      report('warning', error instanceof Error ? error.message : TEXT.handlerFailed);
      return;
    }
    // Everything that showed what was deleted looks again.
    for (const view of this.state.views.values()) {
      if (this.viewFolder(view)?.key === folderKey) this.setRestorePreview(view, null);
    }
    this.refreshFolderViews(folderKey);
    report('info', TEXT.storedDataDeleted);
    tracker.prewarm(folder, this.deps.env.settings());
  }

  // ---- review ---------------------------------------------------------------------------------------

  /** Deletes what no review, checkpoint or log entry refers to, when nothing else is using the folder. */
  /** After a turn or a recovery: let the checkpoints know, then drop what retention and the roots allow. */
  private collectGarbageSoon(folderKey: FolderKey): void {
    this.checkpoints?.changed(folderKey);
    void this.maintainFolder(folderKey);
  }

  private async maintainFolder(folderKey: FolderKey): Promise<void> {
    await this.collectGarbageNow(folderKey);
    const { checkpoints } = this;
    if (!checkpoints || this.disposed) return;
    try {
      const pruned = await checkpoints.prune(folderKey, this.deps.env.settings());
      if (pruned.removedRecords > 0) await this.collectGarbageNow(folderKey);
    } catch (error) {
      this.logger.warn('old checkpoints could not be removed', { error: redact(String(error)) });
    }
  }

  /** Resolves when the clean-up has run or been skipped. Never rejects. */
  collectGarbageNow(folderKey: FolderKey): Promise<void> {
    const { engine, tracker } = this;
    if (!engine || !tracker || this.disposed) return Promise.resolve();
    return (async () => {
      const folder = tracker.folder(folderKey);
      if (!folder || folder.busy()) return;
      await folder.exclusive(async () => {
        // This may run long after it was asked for, even after the application was disposed.
        // Without a root set just obtained, nothing may be deleted: an empty one deletes everything.
        const skip = (reason: string): void => {
          this.logger.info('stored file contents were not cleaned up', { reason });
        };
        if (this.disposed) return skip('the application is shutting down');
        if (tracker.folder(folderKey) !== folder) return skip('the folder is no longer tracked');
        if (folder.busy()) return;
        let roots: Set<string>;
        try {
          roots = await engine.referencedHashes(folderKey);
        } catch (error) {
          return skip(`the files still in use could not be listed: ${redact(String(error))}`);
        }
        if (this.disposed || tracker.folder(folderKey) !== folder) {
          return skip('the application changed while the files in use were listed');
        }
        await collectGarbage(folder.blobs, roots);
      });
    })().catch((error: unknown) => {
      this.logger.warn('stored file contents could not be cleaned up', {
        error: redact(String(error)),
      });
    });
  }

  /**
   * After an Agent turn: how many files it left pending for review. Runs after the tracker and the
   * review engine have seen the turn.
   */
  private reviewNotice(tracker: WorkspaceTracker, engine: ReviewEngine): TurnObserver {
    return {
      afterTurn: async (context) => {
        if (context.mode !== 'agent') return [];
        const operations = new Set(
          (tracker.folder(context.folder.key)?.log.records() ?? []).flatMap((record) =>
            record.type === 'operation' && record.turnId === context.turnId ? [record.id] : [],
          ),
        );
        if (operations.size === 0) return [];
        const touched = (await engine.entries(context.folder.key)).filter(
          (entry) =>
            entry.status === 'pending' && entry.operationIds.some((id) => operations.has(id)),
        );
        if (touched.length === 0) return [];
        const count = touched.length === 1 ? '1 file' : `${touched.length} files`;
        return [
          {
            level: 'info',
            text: `This turn changed ${count}. Review them in the changes card below the chat.`,
          },
        ];
      },
    };
  }

  /** The review entries of the view's folder. */
  private syncReviewEntries(view: ViewRecord): void {
    const { engine } = this;
    if (!engine || view.disposed) return;
    const token = ++view.reviewToken;
    const folder = this.viewFolder(view);
    void (async () => {
      const entries = folder ? await engine.entries(folder.key) : [];
      if (view.disposed || token !== view.reviewToken) return;
      if (canonicalJson(entries) === canonicalJson(view.state.review.entries)) return;
      view.apply([{ op: 'set', path: ['review', 'entries'], value: entries }]);
    })().catch((error: unknown) => {
      this.logger.warn('the review could not be read', { error: redact(String(error)) });
    });
  }

  /** Accepting is only recorded while no Agent turn runs in the folder: say so instead of ignoring it. */
  private acceptRefused(view: ViewRecord): boolean {
    const folder = this.viewFolder(view);
    if (!folder) return false;
    const running = this.agentRunningIn(folder.key);
    if (running) this.state.toast(view, 'warning', TEXT.waitBeforeAccepting);
    return running;
  }

  /** An Agent turn runs in the folder: file changes cannot be accepted or rejected meanwhile. */
  private agentRunningIn(folderKey: FolderKey): boolean {
    return [...this.runs.values()].some(
      (run) => run.folderKey === folderKey && run.mode === 'agent',
    );
  }

  private syncReviewBusy(view: ViewRecord): void {
    if (view.disposed) return;
    const folder = this.viewFolder(view);
    const next = folder !== undefined && this.agentRunningIn(folder.key);
    if (next === view.state.review.busy) return;
    view.apply([{ op: 'set', path: ['review', 'busy'], value: next }]);
  }

  /** Every view of every folder, after a run started or ended. */
  private syncReviewBusyAll(): void {
    for (const view of this.state.views.values()) this.syncReviewBusy(view);
  }

  /** The engine and folder a review message is about. Without them the feature is not there. */
  private reviewTarget(view: ViewRecord): { engine: ReviewEngine; folder: FolderInfo } | undefined {
    const folder = this.viewFolder(view);
    if (!this.engine || !folder) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return undefined;
    }
    return { engine: this.engine, folder };
  }

  private reviewFailed(report: Report, error: unknown): void {
    this.logger.info('a review action was refused', { error: redact(String(error)) });
    report('warning', error instanceof Error ? error.message : TEXT.handlerFailed);
  }

  /** Messages for one view: they appear as toasts in that view. */
  private reportToView(view: ViewRecord): Report {
    return (level, text) => this.state.toast(view, level, text);
  }

  /** Messages about a folder, for callers that have no view (a command): every view showing it hears them. */
  private reportToFolder(folderKey: FolderKey): Report {
    return (level, text) => {
      const shown = [...this.state.views.values()].filter(
        (view) => !view.disposed && this.viewFolder(view)?.key === folderKey,
      );
      if (shown.length === 0) {
        this.logger.info('a review message had no view to show it', { level, text });
        return;
      }
      for (const view of shown) this.state.toast(view, level, text);
    };
  }

  private refreshReviewOf(folderKey: FolderKey): void {
    for (const view of this.state.views.values()) {
      if (this.viewFolder(view)?.key === folderKey) this.syncReviewEntries(view);
    }
  }

  /** Runs an engine call that returns nothing; whatever it throws becomes a toast. */
  private async reviewAction(
    view: ViewRecord,
    action: (engine: ReviewEngine, key: FolderKey) => Promise<void>,
  ): Promise<void> {
    const target = this.reviewTarget(view);
    if (!target) return;
    try {
      await action(target.engine, target.folder.key);
    } catch (error) {
      this.reviewFailed(this.reportToView(view), error);
    }
    this.syncReviewEntries(view);
  }

  private reportRejectProblem(report: Report, result: RejectResult): void {
    if (result.status === 'refused') report('warning', result.message);
    else if (result.status === 'conflict') {
      report(
        'warning',
        result.reason === 'unsaved-editor' ? TEXT.unsavedInEditor : TEXT.changedSinceAgent,
      );
    }
  }

  private async openReviewDiff(view: ViewRecord, path: RelPath): Promise<void> {
    const folder = this.viewFolder(view);
    if (!folder || !this.engine) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return;
    }
    await this.deps.ui.openChangeDiff(folder.key, path);
  }

  private async openAllChanges(view: ViewRecord): Promise<void> {
    const folder = this.viewFolder(view);
    if (!folder || !this.engine) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return;
    }
    await this.deps.ui.openAllChanges(folder.key);
  }

  private async rejectFileForView(view: ViewRecord, path: RelPath): Promise<void> {
    const folder = this.viewFolder(view);
    if (!folder) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return;
    }
    await this.rejectFileWith(folder.key, path, this.reportToView(view));
    this.syncReviewEntries(view);
  }

  private async rejectAllForView(view: ViewRecord, includePaths: RelPath[]): Promise<void> {
    const folder = this.viewFolder(view);
    if (!folder) {
      this.state.toast(view, 'info', TEXT.notAvailableYet);
      return;
    }
    await this.rejectAllWith(folder.key, includePaths, this.reportToView(view));
    this.syncReviewEntries(view);
  }

  /** The engine and the open folder with this key, or a message that the feature is not there. */
  private reviewTargetFor(
    folderKey: FolderKey,
    report: Report,
  ): { engine: ReviewEngine; folder: FolderInfo } | undefined {
    const folder = this.deps.env.folders().find((candidate) => candidate.key === folderKey);
    if (!this.engine || !folder) {
      report('info', TEXT.notAvailableYet);
      return undefined;
    }
    return { engine: this.engine, folder };
  }

  async rejectFileInteractive(folderKey: FolderKey, path: string): Promise<void> {
    await this.rejectFileWith(folderKey, path, this.reportToFolder(folderKey));
  }

  async rejectAllInteractive(folderKey: FolderKey, includePaths: readonly string[]): Promise<void> {
    await this.rejectAllWith(folderKey, includePaths, this.reportToFolder(folderKey));
  }

  /** The one implementation of "Reject" for a file: strict first, and the user decides when it changed since. */
  private async rejectFileWith(
    folderKey: FolderKey,
    rawPath: string,
    report: Report,
  ): Promise<void> {
    const target = this.reviewTargetFor(folderKey, report);
    if (!target) return;
    const path = RelPathSchema.safeParse(rawPath);
    if (!path.success) {
      report('warning', TEXT.pathNotInFolder);
      return;
    }
    try {
      const result = await target.engine.rejectFile(folderKey, path.data, 'strict');
      if (result.status === 'conflict' && result.reason === 'changed-since') {
        await this.askHowToReject(report, target, path.data, result.canRevertAgentOnly);
      } else if (result.status === 'conflict' && result.reason === 'uncertain-source') {
        await this.askAboutUncertainSource(report, target, path.data);
      } else {
        this.reportRejectProblem(report, result);
      }
    } catch (error) {
      this.reviewFailed(report, error);
    }
    this.refreshReviewOf(folderKey);
  }

  /** The entry may hold the user's own work: only the user may decide to discard it. */
  private async askAboutUncertainSource(
    report: Report,
    target: { engine: ReviewEngine; folder: FolderInfo },
    path: RelPath,
  ): Promise<void> {
    const choice = await this.deps.ui.choose({
      title: 'This change may include your own work',
      detail: `${safeText(path)}: AgentCanopy cannot tell the agent's changes apart from yours in this file. Restoring the earlier version discards everything changed since the turn started.`,
      options: [
        { id: 'diff', label: 'Review in Diff Editor' },
        { id: 'overwrite', label: 'Restore the Earlier Version' },
      ],
    });
    if (choice === 'diff') {
      await this.deps.ui.openChangeDiff(target.folder.key, path);
    } else if (choice === 'overwrite') {
      const result = await target.engine.rejectFile(target.folder.key, path, 'overwrite');
      this.reportRejectProblem(report, result);
    }
  }

  /** The file is not what the agent left: only the user may decide what happens to their later edits. */
  private async askHowToReject(
    report: Report,
    target: { engine: ReviewEngine; folder: FolderInfo },
    path: RelPath,
    canRevertAgentOnly: boolean,
  ): Promise<void> {
    const options = [
      { id: 'diff', label: 'Review in Diff Editor' },
      ...(canRevertAgentOnly ? [{ id: 'agent-only', label: "Undo Only the Agent's Changes" }] : []),
      { id: 'overwrite', label: 'Discard Later Edits and Restore' },
    ];
    const choice = await this.deps.ui.choose({
      title: 'This file changed after the agent edited it',
      detail: `${safeText(path)} is no longer what the agent left. Choose what to do.`,
      options,
    });
    if (choice === 'diff') {
      await this.deps.ui.openChangeDiff(target.folder.key, path);
    } else if (choice === 'agent-only' || choice === 'overwrite') {
      const result = await target.engine.rejectFile(target.folder.key, path, choice);
      this.reportRejectProblem(report, result);
    }
  }

  /** The one implementation of "Reject all": preview, confirmation, rejection, and what could not be done. */
  private async rejectAllWith(
    folderKey: FolderKey,
    rawPaths: readonly string[],
    report: Report,
  ): Promise<void> {
    const target = this.reviewTargetFor(folderKey, report);
    if (!target) return;
    const { engine } = target;
    const includePaths = rawPaths.flatMap((raw) => {
      const parsed = RelPathSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    try {
      const preview = await engine.previewRejectAll(folderKey, includePaths);
      if (preview.willReject.length === 0) {
        // When something was refused, the reason (a running turn, for instance) says more than "nothing".
        const reason = preview.cannot[0]?.message;
        report(reason === undefined ? 'info' : 'warning', reason ?? TEXT.nothingToReject);
        return;
      }
      const count = preview.willReject.length;
      let detail = 'The files go back to what they were before the agent changed them.';
      // "The agent's changes" is only true for what a tool call of the agent made.
      const attribution = new Map(
        (await engine.entries(folderKey)).map((entry) => [entry.path, entry.attribution]),
      );
      const uncertain = preview.willReject.filter((path) => {
        const who = attribution.get(path);
        return who !== 'agent-tool' && who !== 'agent-command';
      });
      if (uncertain.length > 0) {
        const listed = uncertain.slice(0, MAX_LISTED_REFUSALS).map((path) => `- ${safeText(path)}`);
        if (uncertain.length > MAX_LISTED_REFUSALS) {
          listed.push(`and ${uncertain.length - MAX_LISTED_REFUSALS} more`);
        }
        detail += `\n\n${uncertain.length} of them were not made by one of the agent's tool calls and may include your own work:\n${listed.join('\n')}`;
      }
      if (preview.cannot.length > 0) {
        const listed = preview.cannot
          .slice(0, MAX_LISTED_REFUSALS)
          .map((item) => `- ${safeText(item.path)}: ${safeText(item.message)}`);
        if (preview.cannot.length > MAX_LISTED_REFUSALS) {
          listed.push(`and ${preview.cannot.length - MAX_LISTED_REFUSALS} more`);
        }
        detail +=
          (preview.cannot.length === 1
            ? '\n\n1 change cannot be rejected and stays as it is:\n'
            : `\n\n${preview.cannot.length} changes cannot be rejected and stay as they are:\n`) +
          listed.join('\n');
      }
      const confirmed = await this.deps.ui.confirm({
        title: `Reject ${count} ${count === 1 ? 'change' : 'changes'}?`,
        detail,
        confirmLabel: 'Reject Changes',
      });
      if (!confirmed) return;
      // Only what the confirmation counted: a change that appeared meanwhile is left alone.
      const result = await engine.rejectAll(folderKey, includePaths, preview.willReject);
      if (result.failed.length === 1) {
        report('warning', '1 change could not be rejected. It is still listed for review.');
      } else if (result.failed.length > 1) {
        report(
          'warning',
          `${result.failed.length} changes could not be rejected. They are still listed for review.`,
        );
      }
    } catch (error) {
      this.reviewFailed(report, error);
    }
    this.refreshReviewOf(folderKey);
  }

  // ---- plans ----------------------------------------------------------------------------------------

  /** The stored plan, or a toast saying it is gone. */
  private async findPlan(view: ViewRecord, planId: PlanId): Promise<PlanDoc | undefined> {
    if (!this.plans) {
      this.state.toast(view, 'warning', TEXT.noStorage);
      return undefined;
    }
    let plan: PlanDoc | undefined;
    try {
      plan = await this.plans.get(planId);
    } catch (error) {
      this.logger.warn('a plan could not be read', { error: redact(String(error)) });
    }
    if (!plan) this.state.toast(view, 'warning', TEXT.planGone);
    return plan;
  }

  /** Shows a changed plan in every view of its conversation. */
  private showPlan(plan: PlanDoc): void {
    const runtime = this.state.runtimes.get(plan.conversationId);
    if (runtime) this.state.mutate(runtime, [{ op: 'set', path: ['plan'], value: plan }]);
  }

  private async decideInPlan(
    view: ViewRecord,
    message: Extract<WebviewMessage, { type: 'plan.decide' }>,
  ): Promise<void> {
    const plan = await this.findPlan(view, message.planId);
    if (!plan || !this.plans) return;
    try {
      const next = await this.plans.decide(plan.id, {
        targetId: message.targetId,
        kind: message.kind,
        values: message.values,
      });
      this.showPlan(next);
    } catch (error) {
      this.logger.info('a decision was refused', { error: redact(String(error)) });
      this.state.toast(view, 'warning', TEXT.decisionFailed);
    }
  }

  private async revertPlan(view: ViewRecord, planId: PlanId, version: number): Promise<void> {
    const plan = await this.findPlan(view, planId);
    if (!plan || !this.plans) return;
    if (this.isBusy(plan.conversationId)) {
      this.state.toast(view, 'warning', TEXT.waitForTurn);
      return;
    }
    try {
      this.showPlan(await this.plans.revert(plan.id, version));
    } catch (error) {
      this.logger.info('a plan could not be reverted', { error: redact(String(error)) });
      this.state.toast(view, 'warning', TEXT.revertFailed);
    }
  }

  private async comparePlan(
    view: ViewRecord,
    planId: PlanId,
    left: number,
    right: number,
  ): Promise<void> {
    const plan = await this.findPlan(view, planId);
    if (!plan) return;
    const first = plan.versions.find((candidate) => candidate.version === left);
    const second = plan.versions.find((candidate) => candidate.version === right);
    if (!first || !second) {
      this.state.toast(view, 'warning', TEXT.planVersionGone);
      return;
    }
    const latest = plan.versions[plan.versions.length - 1] ?? second;
    await this.deps.ui.showDiff({
      title: `${latest.content.title}: version ${left} ↔ version ${right}`,
      leftLabel: `Version ${left}`,
      leftText: renderPlanMarkdown(first.content),
      rightLabel: `Version ${right}`,
      rightText: renderPlanMarkdown(second.content),
    });
  }

  private async openPlanVersion(view: ViewRecord, planId: PlanId, version: number): Promise<void> {
    const plan = await this.findPlan(view, planId);
    if (!plan) return;
    const found = plan.versions.find((candidate) => candidate.version === version);
    if (!found) {
      this.state.toast(view, 'warning', TEXT.planVersionGone);
      return;
    }
    await this.deps.ui.showReadOnlyDocument({
      key: `plan-${plan.id}-v${version}`,
      title: `Plan v${version} - ${found.content.title}`,
      text: renderPlanMarkdown(found.content),
      beside: view.kind === 'panel',
    });
  }

  /**
   * The only way from a plan to an execution. The order is the safety property: the checks that
   * need no one's answer, the user's confirmation, the approval on disk, and only then the turn.
   */
  private async approvePlan(
    view: ViewRecord,
    planId: PlanId,
    version: number,
    contentHash: string,
  ): Promise<void> {
    const plan = await this.findPlan(view, planId);
    if (!plan || !this.plans) return;
    const id = plan.conversationId;
    if (this.isBusy(id)) {
      this.state.toast(view, 'warning', TEXT.turnRunning);
      return;
    }
    const stored = plan.versions.find((candidate) => candidate.version === version);
    if (!stored) {
      this.state.toast(view, 'warning', TEXT.planVersionGone);
      return;
    }
    if (stored.contentHash !== contentHash) {
      this.state.toast(view, 'warning', TEXT.planChanged);
      return;
    }
    const plans = this.plans;
    const meta = this.store?.list().find((candidate) => candidate.id === id);
    if (!meta) {
      this.state.toast(view, 'warning', TEXT.conversationGone);
      return;
    }
    const unanswered = unansweredCount(plan, version);
    const detail =
      `Version ${version} of "${safeText(stored.content.title)}" will be implemented in Agent mode. ` +
      'Changes are checkpointed and you review them afterwards.' +
      (unanswered > 0
        ? `\n\n${unanswered} question(s) or decision(s) in this plan have no answer yet.`
        : '');

    await this.sendTurn(
      view,
      {
        type: 'turn.send',
        conversationId: id,
        text: `Execute plan version ${version}`,
        mode: 'agent',
        model: meta.model,
      },
      {
        noAttachments: true,
        gate: async () => {
          let confirmed = false;
          try {
            confirmed = await this.deps.ui.confirm({
              title: 'Approve and execute this plan?',
              detail,
              confirmLabel: 'Approve and Execute',
            });
          } catch (error) {
            this.logger.warn('the confirmation could not be shown', {
              error: redact(String(error)),
            });
          }
          if (!confirmed || this.disposed) return false;
          // The dialog was open for a while: a turn of another conversation in this folder may have
          // ended with configuration changes, or may still run. Record nothing then.
          if ((this.tracker?.configChanges(meta.folder).length ?? 0) > 0) {
            this.state.toast(view, 'warning', CONFIG_PENDING_MESSAGE);
            return false;
          }
          if (this.agentRunningIn(meta.folder)) {
            this.state.toast(view, 'warning', BUSY_MESSAGE);
            return false;
          }
          // The approval must be on disk before the turn exists.
          const approval = await plans.approve(planId, version, contentHash);
          if (!approval.ok) {
            this.state.toast(
              view,
              'warning',
              approval.reason === 'hash-mismatch'
                ? TEXT.planChanged
                : approval.reason === 'unknown-version'
                  ? TEXT.planVersionGone
                  : TEXT.planGone,
            );
            return false;
          }
          this.showPlan(approval.plan);
          return { promptText: renderExecutionPrompt(approval.plan, version) };
        },
        onStarted: (run) => {
          void this.recordExecution(planId, version, run);
        },
      },
    );
  }

  private async recordExecution(planId: PlanId, version: number, run: TurnRun): Promise<void> {
    try {
      const next = await this.plans?.setExecutionTurn(planId, version, run.turnId);
      if (next) this.showPlan(next);
    } catch (error) {
      this.logger.warn('the execution turn could not be recorded', {
        error: redact(String(error)),
      });
    }
  }

  // ---- prompts -------------------------------------------------------------------------------------------

  /** The first valid answer wins. Everything else is ignored and only noted in the log. */
  private async answerPrompt(
    promptId: PromptId,
    displayHash: string,
    answer: PromptAnswer,
  ): Promise<void> {
    const entry = this.prompts.get(promptId);
    if (!entry) {
      this.logger.info('ignored an answer: the prompt is not waiting');
      return;
    }
    const problem = answerProblem(entry, displayHash, answer);
    if (problem !== undefined) {
      this.logger.info('ignored an answer', { reason: problem });
      return;
    }
    let effective = answer;
    if (answer.kind === 'permission' && answer.choice === 'allow-always') {
      entry.answering = true;
      let confirmed = false;
      try {
        confirmed = await this.deps.ui.confirm({
          title: 'Always allow this?',
          detail: alwaysAllowDetail(entry.prompt),
          confirmLabel: 'Always allow',
        });
      } catch (error) {
        this.logger.warn('the confirmation could not be shown', { error: redact(String(error)) });
      }
      if (!confirmed) effective = { ...answer, choice: 'allow-once' };
    }
    if (entry.settled) return;
    entry.settle('answered', effective);
  }

  // ---- composer context -----------------------------------------------------------------------------------

  /**
   * The folder that picks, selections and searches of a view resolve against: the folder of the
   * conversation it shows, or else the folder chosen for its draft, or the first folder.
   */
  private contextFolder(view: ViewRecord): FolderInfo | undefined {
    const folders = this.deps.env.folders();
    const active = view.activeId === undefined ? undefined : this.state.runtimes.get(view.activeId);
    const key = active ? active.data.meta.folder : view.draftFolder;
    return folders.find((candidate) => candidate.key === key) ?? folders[0];
  }

  /** Adds attachments to the view's draft list: no duplicates, at most 50. */
  private attach(view: ViewRecord, additions: Attachment[]): void {
    const current = view.state.draftAttachments;
    const known = new Set(current.map((attachment) => canonicalJson(attachment)));
    const next = [...current];
    for (const attachment of additions) {
      const key = canonicalJson(attachment);
      if (known.has(key)) continue;
      if (next.length >= MAX_ATTACHMENTS) {
        this.state.toast(view, 'warning', TEXT.attachmentLimit);
        break;
      }
      known.add(key);
      next.push(attachment);
    }
    if (next.length === current.length) return;
    view.apply([{ op: 'set', path: ['draftAttachments'], value: next }]);
  }

  private async pickContext(view: ViewRecord, what: 'file' | 'folder'): Promise<void> {
    const folder = this.contextFolder(view);
    if (!folder) {
      this.state.toast(view, 'warning', TEXT.noFolder);
      return;
    }
    const paths = await this.deps.ui.pickPaths({ folder, what });
    if (view.disposed) return;
    // The paths are relative to the folder that was asked; the view may have moved on meanwhile.
    if (this.contextFolder(view)?.key !== folder.key) {
      this.logger.info('dropped picked paths: the view moved to another folder');
      return;
    }
    const additions: Attachment[] = [];
    for (const path of paths) {
      const parsed = RelPathSchema.safeParse(path);
      if (parsed.success) additions.push({ kind: what, path: parsed.data });
      else this.logger.warn('ignored a picked path that is not inside the folder');
    }
    this.attach(view, additions);
  }

  private addFromEditor(view: ViewRecord, what: 'selection' | 'diagnostics'): void {
    const folder = this.contextFolder(view);
    if (!folder) {
      this.state.toast(view, 'warning', TEXT.noFolder);
      return;
    }
    const found =
      what === 'selection'
        ? this.deps.ui.currentSelection(folder)
        : this.deps.ui.currentDiagnostics(folder);
    if (!found) {
      this.state.toast(view, 'info', what === 'selection' ? TEXT.noSelection : TEXT.noDiagnostics);
      return;
    }
    const parsed = AttachmentSchema.safeParse(found);
    if (!parsed.success) {
      this.logger.warn('ignored an attachment that is not valid');
      return;
    }
    this.attach(view, [parsed.data]);
  }

  private removeAttachment(view: ViewRecord, attachment: Attachment): void {
    const key = canonicalJson(attachment);
    const current = view.state.draftAttachments;
    const next = current.filter((item) => canonicalJson(item) !== key);
    if (next.length === current.length) return;
    view.apply([{ op: 'set', path: ['draftAttachments'], value: next }]);
    this.pruneImages();
  }

  /**
   * An image pasted into the composer. Everything is checked here, because the webview is not
   * trusted: the text must be exact base64, the size within the limits and the first bytes those of
   * the declared type. Synchronous on purpose: nothing can happen between the paste and the next
   * message of the view. The data itself is never logged or shown.
   */
  private pasteImage(view: ViewRecord, mediaType: ImageMediaType, data: string): void {
    const bytes = decodeBase64(data);
    if (!bytes) {
      this.logger.warn('ignored a pasted image that is not valid base64');
      this.state.toast(view, 'warning', TEXT.imageInvalid);
      return;
    }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      this.logger.warn('ignored a pasted image of an unacceptable size');
      this.state.toast(view, 'warning', TEXT.imageTooLarge);
      return;
    }
    if (!matchesImageSignature(mediaType, bytes)) {
      this.logger.warn('ignored a pasted image that is not of the declared type');
      this.state.toast(view, 'warning', TEXT.imageInvalid);
      return;
    }
    const id = sha256Hex(bytes);
    const draft: Extract<Attachment, { kind: 'image' }>[] = [];
    for (const attachment of view.state.draftAttachments) {
      if (attachment.kind === 'image') draft.push(attachment);
    }
    if (draft.some((attachment) => attachment.id === id)) return;
    if (draft.length >= MAX_IMAGES_PER_MESSAGE) {
      this.state.toast(view, 'warning', TEXT.imageLimit);
      return;
    }
    const total = draft.reduce((sum, attachment) => sum + attachment.bytes, 0);
    if (total + bytes.length > MAX_IMAGE_BYTES_PER_MESSAGE) {
      this.state.toast(view, 'warning', TEXT.imagesTooLarge);
      return;
    }
    this.pruneImages();
    this.imageBytes.set(id, bytes);
    this.attach(view, [{ kind: 'image', id, mediaType, bytes: bytes.length }]);
  }

  /** Forgets the bytes of every image that no view's draft and no queued message refers to any more. */
  private pruneImages(): void {
    if (this.imageBytes.size === 0) return;
    const wanted = new Set<string>();
    for (const view of this.state.views.values()) {
      for (const attachment of view.state.draftAttachments) {
        if (attachment.kind === 'image') wanted.add(attachment.id);
      }
    }
    for (const entry of this.queued.values()) {
      for (const attachment of entry.message.attachments) {
        if (attachment.kind === 'image') wanted.add(attachment.id);
      }
    }
    for (const id of [...this.imageBytes.keys()]) {
      if (!wanted.has(id)) this.imageBytes.delete(id);
    }
  }

  /** Closes the file search of a view; an answer that is still on its way is dropped. */
  private closeFileSearch(view: ViewRecord): void {
    view.fileSearchToken += 1;
    if (view.state.fileSearch !== null)
      view.apply([{ op: 'set', path: ['fileSearch'], value: null }]);
  }

  private async searchContext(view: ViewRecord, query: string): Promise<void> {
    if (query.trim().length === 0) {
      this.closeFileSearch(view);
      return;
    }
    const token = ++view.fileSearchToken;
    const folder = this.contextFolder(view);
    if (!folder) {
      this.closeFileSearch(view);
      return;
    }
    let results: Awaited<ReturnType<FileSearch['search']>>;
    try {
      results = await this.fileSearch.search(
        folder.path,
        this.deps.env.settings().snapshotExclude,
        query,
      );
    } catch (error) {
      this.logger.warn('the file search failed', { error: redact(String(error)) });
      return;
    }
    // Only the newest question may show its answer.
    if (view.disposed || token !== view.fileSearchToken) return;
    view.apply([{ op: 'set', path: ['fileSearch'], value: { query, results } }]);
  }

  /** Attaches a file or folder chosen from the search, once it is known to exist inside the folder. */
  private async addContextPath(
    view: ViewRecord,
    requested: string,
    kind: 'file' | 'folder',
  ): Promise<void> {
    const folder = this.contextFolder(view);
    if (!folder) {
      this.state.toast(view, 'warning', TEXT.noFolder);
      return;
    }
    const path = posix.normalize(requested).replace(/\/+$/, '');
    const verified = await this.verifyInside(folder, path, kind);
    if (view.disposed) return;
    if (!verified) {
      this.state.toast(view, 'warning', TEXT.pathNotInFolder);
      return;
    }
    this.attach(view, [{ kind, path }]);
    this.closeFileSearch(view);
  }

  /** True when the path exists, lies inside the folder also after links are followed, and is of the kind. */
  private async verifyInside(
    folder: FolderInfo,
    path: string,
    kind: 'file' | 'folder',
  ): Promise<boolean> {
    if (path.length === 0 || path.includes('\0')) return false;
    const target = resolve(folder.path, path);
    if (!isInside(resolve(folder.path), target)) return false;
    try {
      const [realFolder, realTarget] = await Promise.all([
        fs.realpath(folder.path),
        fs.realpath(target),
      ]);
      if (!isInside(realFolder, realTarget)) return false;
      const stats = await fs.stat(realTarget);
      return kind === 'file' ? stats.isFile() : stats.isDirectory();
    } catch (error) {
      if (!isNotFound(error)) {
        this.logger.warn('a path could not be checked', { error: redact(String(error)) });
      }
      return false;
    }
  }

  // ---- files, links, banners -------------------------------------------------------------------------------

  private async openFile(view: ViewRecord, path: string, line: number | undefined): Promise<void> {
    const folders = this.deps.env.folders();
    const active = view.activeId === undefined ? undefined : this.state.runtimes.get(view.activeId);
    const base =
      (active ? folders.find((folder) => folder.key === active.data.meta.folder) : undefined) ??
      folders[0];
    if (!base) {
      this.state.toast(view, 'warning', TEXT.noFolder);
      return;
    }
    const target = await resolveInsideWorkspace(folders, base, path);
    if (target === undefined) {
      this.logger.warn('refused to open a file outside the workspace folders');
      this.state.toast(view, 'warning', TEXT.pathOutside);
      return;
    }
    await this.deps.ui.openFile(target, line);
  }

  private async openLink(view: ViewRecord, raw: string): Promise<void> {
    let url: URL | undefined;
    try {
      url = new URL(raw);
    } catch {
      url = undefined;
    }
    if (!url || !ALLOWED_LINK_PROTOCOLS.has(url.protocol)) {
      this.logger.warn('refused to open a link', { protocol: url?.protocol ?? 'unparsable' });
      this.state.toast(view, 'warning', TEXT.linkRefused);
      return;
    }
    await this.deps.ui.openExternal(url.href);
  }

  private async bannerAction(bannerId: string, actionId: string): Promise<void> {
    const banner = this.state.global.banners.find((candidate) => candidate.id === bannerId);
    if (banner?.action?.id !== actionId) {
      this.logger.info('ignored an action for a banner that is not shown');
      return;
    }
    if (actionId === RECOVER_NOW_ACTION.id && bannerId.startsWith('recovery:')) {
      await this.recoverNow((bannerId.split(':')[1] ?? '') as FolderKey);
    } else if (actionId === SIGN_IN_ACTION.id) this.signIn();
    else if (actionId === REFRESH_ACTION.id) await this.refreshProvider();
    else this.logger.info('ignored an unknown banner action');
  }

  private dismissBanner(bannerId: string): void {
    const banner = this.state.global.banners.find((candidate) => candidate.id === bannerId);
    if (!banner?.dismissible) return;
    this.dismissed.add(bannerKey(banner));
    this.state.patchGlobal({ banners: this.banners(this.state.global.provider) });
  }
}

/** What tests may look at that the application itself does not expose. */
export interface ControllerInternals {
  /** The workspace tracker, when the application created one. */
  tracker(): WorkspaceTracker | undefined;
  /** The rule store of the default policy, when the application created one. */
  rules(): RuleStore | undefined;
  /** The review engine, with the extras the application uses itself. */
  reviewEngine(): ReviewEngine | undefined;
  /** Asks for the clean-up of stored file contents; resolves when it has run or been skipped. */
  collectGarbage(folderKey: FolderKey): Promise<void>;
  /** The checkpoint service, with the extras the application uses itself. */
  checkpointService(): CheckpointEngine | undefined;
}

export function createAppControllerWithInternals(
  deps: AppDeps,
  options: { projectConfigGate?: boolean } = {},
): {
  controller: AppController;
  internals: ControllerInternals;
} {
  const controller = new Controller(deps, options);
  return {
    controller,
    internals: {
      tracker: () => controller.trackerInUse,
      rules: () => controller.rulesInUse,
      reviewEngine: () => controller.review(),
      collectGarbage: (folderKey) => controller.collectGarbageNow(folderKey),
      checkpointService: () => controller.checkpointsInUse,
    },
  };
}

export function createAppController(deps: AppDeps): AppController {
  return new Controller(deps);
}
