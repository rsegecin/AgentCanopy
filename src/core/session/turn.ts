import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PromptSchema } from '../../shared';
import type {
  AgentEvent,
  ApprovalSource,
  AssistantMessage,
  Attachment,
  ConversationId,
  ConversationMeta,
  FolderKey,
  ForkInfo,
  Message,
  MessageId,
  MessagePart,
  Mode,
  PatchOp,
  Prompt,
  PromptAnswer,
  PromptId,
  ResultEvent,
  SessionEvent,
  Settings,
  StatePath,
  ToolCallEvent,
  ToolCallView,
  ToolResultEvent,
  Turn,
  TurnId,
  TurnOutcome,
  UsageInfo,
  UserMessage,
} from '../../shared';
import type {
  AgentProvider,
  Clock,
  ExecutionProfile,
  FolderInfo,
  Logger,
  NewPrompt,
  PermissionRequest,
  PermissionResponse,
  PolicyContext,
  ProjectConfigChoice,
  PolicyDecision,
  PolicyFinding,
  SessionRef,
  TurnContext,
  ToolHookEvent,
  TurnHandle,
  TurnImage,
  TurnObserver,
  TurnPolicy,
  TurnRegistration,
  TurnRequest,
  ToolTextResult,
  AppDeps,
} from '../contracts';
import { SYSTEM_PROMPT_APPEND, composePrompt } from '../conversations/compose';
import { reconstructContext } from '../conversations/reconstruct';
import type { ConversationStore } from '../conversations/store';
import { planToolInputSchema, renderPlanBlock } from '../plans';
import type { PlanStore } from '../plans';
import { ensurePrivateDir, newId, redact } from '../util';
import { isInside } from './paths';
import { displayHashOf } from './prompts';
import type { PendingPrompt } from './prompts';
import { previewOf } from './state';
import type { ConvRuntime, SessionState } from './state';
import { TEXT, errorSentence, formatResetTime, resultSentence } from './text';

/** The assistant message is written at most this often while it changes. */
const PERSIST_INTERVAL_MS = 1000;
/** Names of unsaved files listed in the warning before the turn. */
const MAX_UNSAVED_LISTED = 5;

type MetaPatch = Parameters<ConversationStore['updateMeta']>[1];

const set = (path: StatePath, value: unknown): PatchOp => ({ op: 'set', path, value });
const push = (path: StatePath, value: unknown): PatchOp => ({ op: 'push', path, value });

/** What the turn run needs from the application. */
export interface TurnServices {
  deps: AppDeps;
  policy: TurnPolicy;
  /** Called around the turn, in order. */
  observers: readonly TurnObserver[];
  state: SessionState;
  store: ConversationStore;
  plans: PlanStore;
  /** The workspace's private storage directory. */
  storageDir: string;
  /** Prompts waiting for an answer, by id, across all turns. */
  prompts: Map<PromptId, PendingPrompt>;
  refreshProvider(): Promise<void>;
  /** A turn was refused before it started (for example because the folder is busy). */
  onRefused?(folder: FolderInfo, mode: Mode): void;
  /** Paths AgentCanopy reverted since the last agent turn in a folder, to tell the agent about. */
  revertedSinceLastTurn?(folderKey: FolderKey): Promise<string[]>;
  /**
   * Decides how the project's own Claude Code configuration is treated in a turn. Undefined: not
   * asked (the application was built with its own policy), so the profile says nothing about it.
   */
  resolveProjectConfig?(
    folder: FolderInfo,
    mode: Mode,
  ): Promise<{ choice: ProjectConfigChoice; notice?: string } | undefined>;
  /** The user chose "always allow" and the policy has decided: the rule should be stored by now. */
  onAlwaysAllowChosen?(conversationId: ConversationId, folderKey: FolderKey, rule: string): void;
  /**
   * What a branch needs to know about the conversation it was cut from. Undefined when it is gone.
   * When no turn runs in the parent, no turn can start in it until `release` is called.
   */
  forkParent?(parentId: ConversationId): Promise<
    | {
        meta: ConversationMeta;
        /** The parent's turns, oldest first, with the provider event that ends each. */
        turns: { id: TurnId; forkPointEventId?: string }[];
        /** Whether a turn is running in the parent. Then nothing is held. */
        running: boolean;
        release: () => void;
      }
    | undefined
  >;
  /** Called once when the run has ended and everything is written. */
  onEnded(run: TurnRun): void;
}

/** What the user asked for and what was decided before the run starts. */
export interface TurnStart {
  runtime: ConvRuntime;
  provider: AgentProvider;
  folder: FolderInfo;
  profile: ExecutionProfile;
  settings: Settings;
  /** What the user sees as their message. */
  text: string;
  /** What the provider is asked, when that differs from `text` (the execution prompt of a plan). */
  promptText?: string;
  mode: Mode;
  model: string;
  attachments: Attachment[];
  /** Bytes of the images in this message, in order. Only for a turn that sends images. */
  images?: TurnImage[];
}

interface SessionPlan {
  ref: SessionRef;
  /** Reconstructed earlier conversation, put in front of the prompt for a new session. */
  prefix: string;
}

interface FinalState {
  status: 'completed' | 'interrupted' | 'error';
  error?: string;
}

function sessionIdOf(ref: SessionRef): string {
  return ref.kind === 'fork' ? ref.newSessionId : ref.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One turn, from the user's message to the end of the provider process. It keeps the conversation
 * in memory, in the views that show it and in the store in step, and answers the provider's
 * permission requests through the policy.
 */
export class TurnRun {
  readonly turnId: TurnId = newId<TurnId>();
  readonly conversationId: ConversationId;
  readonly folderKey: FolderKey;
  readonly mode: Mode;
  /** Resolves when the turn has ended and everything is written. Never rejects. */
  readonly done: Promise<void>;

  private resolveDone: () => void = () => undefined;
  /** Aborts when the turn is cancelled, which includes the application shutting down. */
  private readonly abort = new AbortController();
  private readonly runtime: ConvRuntime;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly runDir: string;

  private cancelRequested = false;
  /** Set when the run is wrapping up; late callbacks then leave the conversation alone. */
  private closed = false;
  private handle: TurnHandle | undefined;
  private registration: TurnRegistration | undefined;
  private session: SessionPlan = { ref: { kind: 'new', sessionId: '' }, prefix: '' };
  private retried = false;
  private failed = false;
  private killReason: string | undefined;
  /** Set when the provider ended with a limit: the turn shows an error, observers are told `limit`. */
  private hitLimit = false;
  /** Observers whose `beforeTurn` finished: they get `afterTurn`. Set once the turn context exists. */
  private ranBefore: TurnObserver[] = [];
  private turnContext: TurnContext | undefined;
  /** The handle whose process id observers have been told about. */
  private pidReportedFor: TurnHandle | undefined;
  /** Tool calls that have started (or asked for permission) and have no result yet. */
  private readonly openCalls = new Set<string>();
  /** Notice texts a policy finding has added, so each is shown once. */
  private readonly findingNotices = new Set<string>();
  /** Plan changes of this turn run one after the other, so each sees the result of the one before. */
  private planWork: Promise<unknown> = Promise.resolve();
  /** The model called the plan tool in this turn, whatever came of it. */
  private planToolCalled = false;
  /** The session id of an exact fork that has been started and not yet shown to work. */
  private forkAttempt: string | undefined;
  /** What the user decided about the project's configuration, once asked. */
  private projectConfig: ProjectConfigChoice | undefined;
  /** The profile the provider runs with: the policy's, plus the project configuration decision. */
  private profile: ExecutionProfile;
  /** The rule the user asked to always allow, by tool call, until the policy has decided. */
  private readonly alwaysRules = new Map<string, string>();
  /** Lets the parent of a branch take turns again; set while an exact copy of its session is unconfirmed. */
  private parentRelease: (() => void) | undefined;
  private final: FinalState | undefined;
  private usage: UsageInfo | undefined;
  private forkPointEventId: string | undefined;

  private prompt = '';
  private userIndex = -1;
  private assistantIndex: number | undefined;
  /** The text or thinking part that deltas are still being appended to. */
  private open: { index: number; kind: 'text' | 'thinking' } | undefined;
  private readonly toolIndex = new Map<string, number>();
  /** Tool calls with a permission request pending, whether or not their part exists yet. */
  private readonly awaiting = new Set<string>();
  private readonly approvals = new Map<string, ApprovalSource>();
  private readonly entries = new Set<PendingPrompt>();
  private sawOutput = false;
  private errorNoticed = false;
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly writes = new Set<Promise<void>>();

  constructor(
    private readonly services: TurnServices,
    private readonly input: TurnStart,
  ) {
    this.runtime = input.runtime;
    this.conversationId = input.runtime.id;
    this.folderKey = input.folder.key;
    this.mode = input.mode;
    this.profile = input.profile;
    this.logger = services.deps.logger;
    this.clock = services.deps.clock ?? { now: () => Date.now() };
    this.runDir = join(services.storageDir, 'run', `turn-${this.turnId}`);
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Begins the turn. The user's message is in the views before this returns. */
  start(): void {
    void this.execute();
  }

  /** Stops the turn: waiting prompts are cancelled first, then the provider is asked to stop. */
  cancel(): Promise<void> {
    if (!this.cancelRequested) {
      this.cancelRequested = true;
      for (const entry of [...this.entries]) entry.settle('cancelled');
      this.abort.abort();
    }
    return this.handle ? this.handle.cancel() : Promise.resolve();
  }

  // ---- the run -----------------------------------------------------------------------------------

  private async execute(): Promise<void> {
    try {
      this.begin();
      await this.prepare();
      await this.composeTurnPrompt();
      if ((await this.runBeforeTurn()) && !this.cancelRequested) {
        this.warnAboutUnsavedFiles();
        await this.settleProjectConfig();
        if (!this.cancelRequested) {
          await this.planForkSession();
          let outcome = await this.consume(await this.launch(this.session));
          if (outcome === 'retry' && !this.cancelRequested) {
            await this.restartWithoutSession();
            outcome = await this.consume(await this.launch(this.session));
          }
        }
      }
    } catch (error) {
      this.failed = true;
      this.logger.error('a turn failed', { error: redact(String(error)) });
    } finally {
      await this.finish();
    }
  }

  /**
   * The project's own Claude Code configuration can run programs without asking: the user decides
   * before the provider starts, and the decision goes into the profile and to the policy.
   */
  private async settleProjectConfig(): Promise<void> {
    if (!this.services.resolveProjectConfig) return;
    let resolved: Awaited<ReturnType<NonNullable<TurnServices['resolveProjectConfig']>>>;
    try {
      resolved = await this.services.resolveProjectConfig(this.input.folder, this.input.mode);
    } catch (error) {
      // Without an answer nothing of the project is used.
      this.logger.warn('the project configuration could not be checked', {
        error: redact(String(error)),
      });
      resolved = { choice: { settings: 'ignore', mcp: 'ignore' } };
    }
    if (!resolved) return;
    this.projectConfig = resolved.choice;
    this.profile = { ...this.input.profile, projectConfig: resolved.choice };
    if (resolved.notice !== undefined) this.addNotice('info', resolved.notice);
  }

  /** The user message and the turn go into the state at once, before anything is awaited. */
  private begin(): void {
    const { state } = this.services;
    const { text, mode, model, attachments } = this.input;
    const now = this.clock.now();
    const user: UserMessage = {
      role: 'user',
      id: newId<MessageId>(),
      turnId: this.turnId,
      createdAt: now,
      text,
      mode,
      attachments,
    };
    const turn: Turn = { id: this.turnId, mode, model, startedAt: now, status: 'preparing' };
    this.userIndex = this.runtime.data.messages.length;
    const ops = [
      push(['messages'], user),
      push(['turns'], turn),
      set(['activity'], 'Starting Claude Code…'),
    ];
    state.running.add(this.conversationId);
    state.mutate(this.runtime, ops);
    state.previews.set(this.conversationId, previewOf([user]));
    state.refreshSummaries();
  }

  /** The prompt for the provider. Built after the turn is stored, because it asks the review for what was reverted. */
  private async composeTurnPrompt(): Promise<void> {
    const { text, mode, attachments } = this.input;
    const { plan, meta } = this.runtime.data;
    let revertedPaths: string[] = [];
    try {
      revertedPaths = (await this.services.revertedSinceLastTurn?.(this.input.folder.key)) ?? [];
    } catch (error) {
      this.logger.warn('the reverted files could not be listed', { error: redact(String(error)) });
    }
    this.prompt = composePrompt({
      mode,
      text: this.input.promptText ?? text,
      attachments,
      planLocked: meta.planLocked,
      ...(revertedPaths.length > 0 ? { revertedPaths } : {}),
      // The execution prompt of an approved plan carries that version itself.
      ...(plan && plan.versions.length > 0 && this.input.promptText === undefined
        ? {
            // Only the Plan mode turn of an unlocked plan may change it; everywhere else it is read-only.
            planBlock: renderPlanBlock(plan, { locked: mode !== 'plan' || meta.planLocked }),
          }
        : {}),
    });
  }

  private async prepare(): Promise<void> {
    const { store } = this.services;
    const user = this.runtime.data.messages[this.userIndex];
    const turn = this.currentTurn();
    if (user && turn) {
      await store.putMessage(this.conversationId, user);
      await store.putTurn(this.conversationId, turn);
    }
    const meta = this.runtime.data.meta;
    const patch: MetaPatch = {};
    if (meta.mode !== this.input.mode) patch.mode = this.input.mode;
    if (meta.model !== this.input.model) patch.model = this.input.model;
    if (Object.keys(patch).length > 0) await this.patchMeta(patch);

    if (meta.sessionId !== undefined && meta.fork?.exactness !== 'pending') {
      this.session = { ref: { kind: 'resume', sessionId: meta.sessionId }, prefix: '' };
    } else if (meta.fork?.exactness !== 'pending') {
      this.session = await this.freshSession();
    }
    // A branch that is still pending is planned just before the provider starts: see `planForkSession`.
  }

  /**
   * The session of a branch's first turn is decided at the last moment: what the parent holds can
   * change while the observers of the turn are still preparing.
   */
  private async planForkSession(): Promise<void> {
    const fork = this.runtime.data.meta.fork;
    if (fork?.exactness === 'pending') this.session = await this.planFork(fork);
  }

  /**
   * The first turn of a branch decides how its context is carried. A branch is only called exact
   * when the turn really ran on a copy of the parent's session (or on none, with nothing kept);
   * until then it stays pending.
   */
  private async planFork(fork: ForkInfo): Promise<SessionPlan> {
    // What the branch keeps is what the parent turn named in `lastKeptParentTurnId` ends with. The
    // branch's own turns, such as an earlier try that failed, never count as kept.
    // Messages of earlier turns that the branch carries. With none, a new session is an exact start.
    const carriesMessages = this.runtime.data.messages.some(
      (message) => message.turnId !== this.turnId,
    );
    if (fork.lastKeptParentTurnId === undefined && !carriesMessages) {
      const sessionId = newId();
      await this.patchMeta({ sessionId, fork: { ...fork, exactness: 'exact', lost: [] } });
      return { ref: { kind: 'new', sessionId }, prefix: '' };
    }

    let parent: Awaited<ReturnType<NonNullable<TurnServices['forkParent']>>>;
    try {
      parent = await this.services.forkParent?.(fork.parentId);
    } catch (error) {
      this.logger.warn('the parent of a branch could not be read', {
        error: redact(String(error)),
      });
    }
    let notice: string | undefined;
    if (parent?.meta.sessionId !== undefined && !parent.running) {
      const capabilities = this.services.state.global.provider?.capabilities;
      const fromSessionId = parent.meta.sessionId;
      const lastOfParent = parent.turns[parent.turns.length - 1];
      if (lastOfParent?.id === fork.lastKeptParentTurnId && capabilities?.forkWhole !== false) {
        // The branch keeps everything the parent has: copy the whole session.
        this.parentRelease = parent.release;
        return this.startForkAttempt({ kind: 'fork', fromSessionId, newSessionId: newId() });
      }
      const keptTurn = parent.turns.find((turn) => turn.id === fork.lastKeptParentTurnId);
      const cutAllowed =
        capabilities?.forkAtMessage === 'exact' && this.input.settings.exactEarlierForks;
      if (cutAllowed && keptTurn?.forkPointEventId !== undefined) {
        this.parentRelease = parent.release;
        return this.startForkAttempt({
          kind: 'fork',
          fromSessionId,
          newSessionId: newId(),
          atProviderEventId: keptTurn.forkPointEventId,
        });
      }
      if (!cutAllowed) notice = TEXT.exactForkUnavailable;
    }
    // Not a copy after all: the parent does not need to be held.
    parent?.release();
    return this.freshSession(notice);
  }

  /** The parent may take turns again: the copy of its session is made or no longer wanted. */
  private releaseParent(): void {
    const release = this.parentRelease;
    this.parentRelease = undefined;
    release?.();
  }

  /** An exact fork is only an attempt until the provider has shown that it worked. */
  private startForkAttempt(ref: Extract<SessionRef, { kind: 'fork' }>): SessionPlan {
    this.forkAttempt = ref.newSessionId;
    return { ref, prefix: '' };
  }

  /** The attempt worked: the branch is exact and its session is the copy. */
  private async confirmFork(): Promise<void> {
    const sessionId = this.forkAttempt;
    const fork = this.runtime.data.meta.fork;
    this.forkAttempt = undefined;
    if (sessionId === undefined || fork?.exactness !== 'pending') return;
    await this.patchMeta({ sessionId, fork: { ...fork, exactness: 'exact', lost: [] } });
  }

  /**
   * A new provider session. Earlier messages, when there are any, travel as a reconstructed
   * transcript in front of the prompt. A branch's first turn always takes this path for now.
   */
  private async freshSession(notice?: string): Promise<SessionPlan> {
    const sessionId = newId();
    const earlier = this.runtime.data.messages.slice(0, this.userIndex);
    const meta = this.runtime.data.meta;
    const patch: MetaPatch = { sessionId };
    let prefix = '';
    if (earlier.length > 0 || meta.fork?.exactness === 'pending') {
      const rebuilt = reconstructContext(earlier);
      if (earlier.length > 0) prefix = rebuilt.text;
      // A branch is only exact while its provider session holds its context: once the earlier
      // messages travel as a transcript in a new session, it is not.
      if (
        meta.fork?.exactness === 'pending' ||
        (meta.fork?.exactness === 'exact' && earlier.length > 0)
      ) {
        patch.fork = { ...meta.fork, exactness: 'reconstructed', lost: rebuilt.lost };
      }
    }
    await this.patchMeta(patch);
    if (notice !== undefined) this.addNotice('info', notice);
    // A branch reports lost images in its own list of what was lost.
    if (
      meta.fork === undefined &&
      earlier.some(
        (message) =>
          message.role === 'user' &&
          message.attachments.some((attachment) => attachment.kind === 'image'),
      )
    ) {
      this.addNotice('info', TEXT.earlierImagesLost);
    }
    return { ref: { kind: 'new', sessionId }, prefix };
  }

  /** Claude Code no longer knows the session: carry on in a new one from the visible messages. */
  private async restartWithoutSession(): Promise<void> {
    this.retried = true;
    this.forkAttempt = undefined;
    this.releaseParent();
    await this.patchMeta({ sessionId: undefined });
    this.addNotice('info', TEXT.sessionLost);
    this.session = await this.freshSession();
  }

  private async launch(plan: SessionPlan): Promise<TurnHandle> {
    const { deps } = this.services;
    this.session = plan;
    this.registration?.dispose();
    this.registration = undefined;
    await fs.rm(this.runDir, { recursive: true, force: true });
    await ensurePrivateDir(this.runDir);
    const planTool = this.offersPlanTool();
    const toolHooks = this.wantsToolHooks();
    const registration = deps.hostTools.registerTurn(
      {
        onPermissionRequest: (request) => this.onPermissionRequest(request),
        ...(toolHooks ? { onToolHook: (event: ToolHookEvent) => this.onToolHook(event) } : {}),
        ...(planTool ? { onPlanSubmitted: (input: unknown) => this.onPlanSubmitted(input) } : {}),
      },
      { toolHooks, ...(planTool ? { planToolInputSchema: planToolInputSchema() } : {}) },
    );
    this.registration = registration;
    const request: TurnRequest = {
      cwd: this.input.folder.path,
      prompt: plan.prefix.length > 0 ? `${plan.prefix}\n\n${this.prompt}` : this.prompt,
      ...(this.input.images ? { images: this.input.images } : {}),
      mode: this.input.mode,
      model: this.input.model,
      session: plan.ref,
      profile: this.profile,
      host: registration.endpoint,
      systemPromptAppend: SYSTEM_PROMPT_APPEND,
      runDir: this.runDir,
    };
    const handle = this.input.provider.startTurn(request);
    this.handle = handle;
    // Not awaited: the events of the turn must not wait for a slow process to print its first line.
    void handle.started.then(
      (pid) => {
        if (pid !== undefined) this.reportProcessStart(handle, pid);
      },
      () => undefined,
    );
    this.setTurn({ status: 'running' }, true);
    if (this.cancelRequested) void handle.cancel();
    return handle;
  }

  private async consume(handle: TurnHandle): Promise<'done' | 'retry'> {
    for await (const event of handle.events) {
      let verdict: 'retry' | undefined;
      try {
        verdict = this.handleEvent(event);
      } catch (error) {
        this.logger.error('an event could not be applied', {
          type: event.type,
          error: redact(String(error)),
        });
      }
      if (verdict === 'retry') {
        await handle.done;
        return 'retry';
      }
    }
    await handle.done;
    return 'done';
  }

  /** Wraps up: settles prompts, cleans up, writes the final state and tells the application. */
  private async finish(): Promise<void> {
    const { state, store } = this.services;
    try {
      for (const entry of [...this.entries]) {
        entry.settle(this.cancelRequested ? 'cancelled' : 'expired');
      }
      this.closed = true;
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.registration?.dispose();
      this.registration = undefined;
      await fs.rm(this.runDir, { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.warn('a run directory could not be removed', { error: redact(String(error)) });
      });

      this.closeTools();
      // The attempt to copy the parent's session is over, whichever way it went.
      this.releaseParent();
      // A call that never reported back did not run, as far as anyone can tell.
      for (const toolCallId of [...this.openCalls]) {
        this.openCalls.delete(toolCallId);
        this.notifyToolResult(toolCallId, false, false);
      }
      this.open = undefined;
      const final = this.finalState();
      if (this.forkAttempt !== undefined && (final.status === 'completed' || this.sawOutput)) {
        await this.confirmFork();
      }
      if (final.error !== undefined && !this.errorNoticed) this.addNotice('error', final.error);
      if (final.status === 'completed' && this.expectedPlan()) {
        this.addNotice('info', TEXT.noPlanSaved);
      }
      await this.runAfterTurn(final);
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = undefined;

      const message = this.assistantMessage();
      if (message) await store.putMessage(this.conversationId, message);
      const current = this.currentTurn();
      if (current) {
        const next: Turn = {
          ...current,
          status: final.status,
          endedAt: this.clock.now(),
          ...(final.error !== undefined ? { error: final.error } : {}),
          // Only a turn that ended normally ends on an event a fork can be cut at.
          ...(this.forkPointEventId !== undefined && final.status === 'completed'
            ? { forkPointEventId: this.forkPointEventId }
            : {}),
          ...(this.usage ? { usage: sanitizeUsage(this.usage) } : {}),
        };
        await store.putTurn(this.conversationId, next);
        const index = this.runtime.data.turns.findIndex((turn) => turn.id === this.turnId);
        state.mutate(this.runtime, [set(['turns', index], next), set(['activity'], null)]);
      }
    } catch (error) {
      this.logger.error('a turn could not be finished cleanly', { error: redact(String(error)) });
    } finally {
      try {
        await Promise.allSettled([...this.writes]);
        state.previews.set(this.conversationId, previewOf(this.runtime.data.messages));
        this.services.onEnded(this);
      } catch (error) {
        this.logger.error('a turn could not be released', { error: redact(String(error)) });
      } finally {
        this.resolveDone();
      }
    }
  }

  // ---- the plan ----------------------------------------------------------------------------------

  private offersPlanTool(): boolean {
    return this.input.profile.kind === 'read-only' && this.input.profile.planTool;
  }

  /** A turn that could have saved a plan, in a conversation that has none, and did not try. */
  private expectedPlan(): boolean {
    if (this.input.mode !== 'plan' || !this.offersPlanTool() || this.planToolCalled) return false;
    const plan = this.runtime.data.plan;
    return plan === null || plan.versions.length === 0;
  }

  private inPlanQueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.planWork.then(job, job);
    this.planWork = next.catch(() => undefined);
    return next;
  }

  /** The model submitted a plan. Its answer tells the model what happened. */
  private onPlanSubmitted(raw: unknown): Promise<ToolTextResult> {
    this.planToolCalled = true;
    return this.inPlanQueue(async (): Promise<ToolTextResult> => {
      const { plans, state } = this.services;
      if (this.closed) return { text: TEXT.turnEnded, isError: true };
      const meta = this.runtime.data.meta;
      const result = await plans.submit({
        conversationId: this.conversationId,
        ...(meta.planId !== undefined ? { planId: meta.planId } : {}),
        raw,
      });
      if (!result.ok) return { text: result.message, isError: true };
      if (meta.planId !== result.plan.id) await this.patchMeta({ planId: result.plan.id });
      state.mutate(this.runtime, [set(['plan'], result.plan)]);
      if (result.unchanged) {
        return {
          text: `The plan is identical to version ${result.version}, so nothing was saved.`,
          isError: false,
        };
      }
      this.pushPart({ kind: 'plan-update', planId: result.plan.id, version: result.version });
      this.persistMessage();
      return {
        text:
          `Plan saved as version ${result.version}. The user reviews it in the plan card in the chat. ` +
          'Do not repeat the plan in chat: say in two or three sentences what it covers, or what changed.',
        isError: false,
      };
    });
  }

  /** An answered interactive question is a decision of the conversation's plan, when it has one. */
  private recordQuestionDecisions(prompt: Prompt, answer: PromptAnswer): void {
    if (prompt.kind !== 'question' || answer.kind !== 'question') return;
    this.track(
      this.inPlanQueue(async () => {
        const planId = this.runtime.data.meta.planId;
        if (planId === undefined) return;
        const { plans, state } = this.services;
        for (const [targetId, values] of Object.entries(answer.answers)) {
          if (values.length === 0) continue;
          const next = await plans.decide(planId, {
            kind: 'interactive-question',
            targetId,
            values,
          });
          state.mutate(this.runtime, [set(['plan'], next)]);
        }
      }),
    );
  }

  // ---- observers ---------------------------------------------------------------------------------

  /**
   * Runs `beforeTurn` of every observer, in order. False when the provider must not be started: an
   * observer threw (the turn then ends with its message, or as interrupted after a cancel).
   */
  private async runBeforeTurn(): Promise<boolean> {
    const { observers } = this.services;
    const meta = this.runtime.data.meta;
    this.turnContext = {
      conversation: meta,
      turnId: this.turnId,
      mode: this.input.mode,
      folder: this.input.folder,
      settings: this.input.settings,
    };
    if (observers.length === 0) return true;
    if (!this.cancelRequested) this.setActivity('Preparing…');
    for (const observer of observers) {
      try {
        await observer.beforeTurn?.(this.turnContext, this.abort.signal);
      } catch (error) {
        if (!this.cancelRequested) {
          const message = error instanceof Error ? error.message : String(error);
          this.final = { status: 'error', error: message.length > 0 ? message : TEXT.turnFailed };
        }
        this.logger.warn('an observer refused the turn', { error: redact(String(error)) });
        if (!this.cancelRequested) this.services.onRefused?.(this.input.folder, this.input.mode);
        return false;
      }
      this.ranBefore.push(observer);
    }
    this.setActivity('Starting Claude Code…');
    return true;
  }

  /** Whether any observer wants a call around every tool of this turn. */
  private wantsToolHooks(): boolean {
    const context = this.turnContext;
    if (!context) return false;
    return this.ranBefore.some((observer) => {
      try {
        return observer.wantsToolHooks?.(context) === true;
      } catch (error) {
        this.logger.warn('an observer could not say whether it wants tool hooks', {
          error: redact(String(error)),
        });
        return false;
      }
    });
  }

  private async onToolHook(event: ToolHookEvent): Promise<void> {
    const context = this.turnContext;
    if (!context) return;
    for (const observer of this.ranBefore) {
      if (!observer.onToolHook) continue;
      try {
        await observer.onToolHook(context, event);
      } catch (error) {
        this.logger.warn('an observer failed on a tool hook', { error: redact(String(error)) });
      }
    }
  }

  /** Tells the observers about the provider process, once per process, as soon as its id is known. */
  private reportProcessStart(handle: TurnHandle, pid: number): void {
    const context = this.turnContext;
    if (!context || this.closed || this.pidReportedFor === handle) return;
    this.pidReportedFor = handle;
    for (const observer of this.ranBefore) {
      try {
        observer.onProcessStarted?.(context, pid);
      } catch (error) {
        this.logger.warn('an observer failed when the process started', {
          error: redact(String(error)),
        });
      }
    }
  }

  /** Tells the observers that a tool call ended. They are not waited for. */
  private notifyToolResult(toolCallId: string, executed: boolean, isError: boolean): void {
    const context = this.turnContext;
    if (!context) return;
    for (const observer of this.ranBefore) {
      try {
        observer.onToolResult?.(context, { toolCallId, executed, isError });
      } catch (error) {
        this.logger.warn('an observer failed on a tool result', { error: redact(String(error)) });
      }
    }
  }

  /** The agent reads files from disk, so edits that exist only in an editor buffer are invisible to it. */
  private warnAboutUnsavedFiles(): void {
    if (this.input.settings.unsavedFiles !== 'warn') return;
    const root = resolve(this.input.folder.path);
    let dirty: string[];
    try {
      dirty = this.services.deps.editor?.dirtyFiles() ?? [];
    } catch (error) {
      this.logger.warn('the open files could not be listed', { error: redact(String(error)) });
      return;
    }
    const names = dirty
      .map((file) => resolve(file))
      .filter((file) => file !== root && isInside(root, file))
      .map((file) => relative(root, file).split('\\').join('/'))
      .sort();
    const unique = [...new Set(names)];
    if (unique.length === 0) return;
    const shown = unique.slice(0, MAX_UNSAVED_LISTED).join(', ');
    const more = unique.length - MAX_UNSAVED_LISTED;
    this.addNotice(
      'warning',
      `${unique.length === 1 ? '1 file has' : `${unique.length} files have`} unsaved changes. ` +
        `The agent only sees what is saved on disk: ${shown}${more > 0 ? ` and ${more} more` : ''}.`,
    );
  }

  /** Tells the observers that ran `beforeTurn` how the turn ended and shows what they report. */
  private async runAfterTurn(final: FinalState): Promise<void> {
    const context = this.turnContext;
    if (!context) return;
    const outcome: TurnOutcome =
      this.hitLimit && this.killReason === undefined && final.status === 'error'
        ? 'limit'
        : final.status;
    for (const observer of this.ranBefore) {
      if (!observer.afterTurn) continue;
      try {
        for (const notice of await observer.afterTurn(context, outcome)) {
          this.addNotice(notice.level, notice.text);
        }
      } catch (error) {
        this.logger.warn('an observer failed after a turn', { error: redact(String(error)) });
      }
    }
  }

  private finalState(): FinalState {
    if (this.killReason !== undefined) return { status: 'error', error: this.killReason };
    if (this.final) return this.final;
    if (this.cancelRequested) return { status: 'interrupted' };
    return { status: 'error', error: this.failed ? TEXT.turnFailed : TEXT.noResult };
  }

  // ---- provider events -----------------------------------------------------------------------------

  private handleEvent(event: AgentEvent): 'retry' | undefined {
    if (this.killReason !== undefined) return undefined;
    const { policy } = this.services;
    if (policy.inspect) {
      let finding: PolicyFinding | undefined;
      try {
        finding = policy.inspect(event, this.policyContext(undefined));
      } catch (error) {
        this.logger.error('the policy could not inspect an event', {
          error: redact(String(error)),
        });
        finding = { stop: TEXT.guardFailed };
      }
      if (finding?.notice !== undefined && finding.notice.length > 0) {
        this.addFindingNotice(finding.notice);
      }
      if (finding?.stop !== undefined) {
        this.stopForGuard(finding.stop);
        return undefined;
      }
    }

    switch (event.type) {
      case 'session':
        this.onSession(event);
        return undefined;
      case 'text-delta':
        if (event.parentToolCallId === null) {
          this.sawOutput = true;
          this.appendDelta(event.kind, event.text);
        }
        return undefined;
      case 'assistant-block':
        if (event.parentToolCallId === null) {
          this.sawOutput = true;
          this.onBlock(event.kind, event.text, event.providerEventId);
        }
        return undefined;
      case 'tool-call':
        this.onToolCall(event);
        return undefined;
      case 'tool-result':
        this.openCalls.delete(event.toolCallId);
        this.notifyToolResult(event.toolCallId, !event.notExecuted, event.isError);
        this.onToolResult(event);
        return undefined;
      case 'status':
        this.onStatus(event.state);
        return undefined;
      case 'retry':
        this.setActivity(`Retrying (${event.attempt} of ${event.maxRetries})…`);
        return undefined;
      case 'rate-limit':
        this.onRateLimit(event.status, event.resetsAt);
        return undefined;
      case 'hook':
        this.logger.debug('a hook event', { phase: event.phase, outcome: event.outcome });
        return undefined;
      case 'unknown':
        this.logger.debug('an unknown event type', { type: event.rawType });
        return undefined;
      case 'error': {
        const sentence = errorSentence(event.category, this.input.model, event.message);
        this.errorNoticed = true;
        this.addNotice('error', sentence);
        if (event.category === 'authentication') {
          this.services.refreshProvider().catch((error: unknown) => {
            this.logger.warn('the provider check failed', { error: redact(String(error)) });
          });
        }
        return undefined;
      }
      case 'result':
        return this.onResult(event);
    }
  }

  private onSession(event: SessionEvent): void {
    if (event.sessionId.length > 0 && event.sessionId !== sessionIdOf(this.session.ref)) {
      this.track(this.patchMeta({ sessionId: event.sessionId }));
    }
  }

  private onStatus(state: 'running' | 'idle' | 'compacting' | 'retrying'): void {
    switch (state) {
      case 'compacting':
        this.setActivity('Compacting the conversation…');
        break;
      case 'running':
        this.setActivity('Working…');
        break;
      case 'retrying':
        this.setActivity('Retrying…');
        break;
      case 'idle':
        this.setActivity(null);
        break;
    }
  }

  private onRateLimit(
    status: 'allowed' | 'warning' | 'rejected',
    resetsAt: number | undefined,
  ): void {
    if (status !== 'rejected') {
      this.logger.debug('a rate limit event', { status });
      return;
    }
    const when = resetsAt === undefined ? undefined : formatResetTime(resetsAt, this.clock.now());
    this.errorNoticed = true;
    this.addNotice(
      'warning',
      when === undefined
        ? "Claude Code's usage limit was reached."
        : `Claude Code's usage limit was reached. It resets at ${when}.`,
    );
    if (when !== undefined) {
      this.services.state.toastConversation(
        this.conversationId,
        'warning',
        `Usage limit reached. It resets at ${when}.`,
      );
    }
  }

  private onResult(event: ResultEvent): 'retry' | undefined {
    if (this.final !== undefined) {
      // A turn has one result. If the provider sends more, the first one stands.
      this.logger.debug('ignored a second result event');
      return undefined;
    }
    if (
      event.category === 'session-not-found' &&
      (this.session.ref.kind === 'resume' || this.session.ref.kind === 'fork') &&
      !this.retried &&
      !this.sawOutput &&
      !this.cancelRequested
    ) {
      return 'retry';
    }
    if (event.usage) this.usage = event.usage;
    switch (event.outcome) {
      case 'completed':
        // The user asked to stop: a turn that happened to finish first is still shown as stopped.
        this.final = { status: this.cancelRequested ? 'interrupted' : 'completed' };
        break;
      case 'interrupted':
        // The provider's own text for an interruption is never shown.
        this.final = { status: 'interrupted' };
        break;
      case 'error':
      case 'limit':
        this.hitLimit = event.outcome === 'limit';
        this.final = { status: 'error', error: resultSentence(event, this.input.model) };
        break;
    }
    return undefined;
  }

  /** The safety guard of the policy refused the turn: stop the process and say why. */
  private stopForGuard(reason: string): void {
    this.killReason = reason;
    this.errorNoticed = true;
    this.addNotice('error', reason);
    this.handle?.kill();
  }

  // ---- the assistant message -----------------------------------------------------------------------

  private assistantMessage(): AssistantMessage | undefined {
    if (this.assistantIndex === undefined) return undefined;
    const message: Message | undefined = this.runtime.data.messages[this.assistantIndex];
    return message?.role === 'assistant' ? message : undefined;
  }

  private ensureAssistant(): number {
    if (this.assistantIndex !== undefined) return this.assistantIndex;
    const message: AssistantMessage = {
      role: 'assistant',
      id: newId<MessageId>(),
      turnId: this.turnId,
      createdAt: this.clock.now(),
      parts: [],
    };
    this.assistantIndex = this.runtime.data.messages.length;
    this.services.state.mutate(this.runtime, [push(['messages'], message)]);
    return this.assistantIndex;
  }

  /** Adds a part at the end. It closes the text part that was still being streamed. */
  private pushPart(part: MessagePart): number {
    const messageIndex = this.ensureAssistant();
    const index = this.assistantMessage()?.parts.length ?? 0;
    this.services.state.mutate(this.runtime, [push(['messages', messageIndex, 'parts'], part)]);
    this.open = undefined;
    this.markDirty();
    return index;
  }

  private appendDelta(kind: 'text' | 'thinking', text: string): void {
    if (this.open?.kind === kind && this.assistantIndex !== undefined) {
      this.services.state.mutate(this.runtime, [
        {
          op: 'appendText',
          path: ['messages', this.assistantIndex, 'parts', this.open.index, 'text'],
          text,
        },
      ]);
      this.markDirty();
      return;
    }
    const index = this.pushPart({ kind, text });
    this.open = { index, kind };
  }

  /** The block is the authoritative text: it replaces what was streamed for it and closes the part. */
  private onBlock(kind: 'text' | 'thinking', text: string, providerEventId: string): void {
    if (providerEventId.length > 0) this.forkPointEventId = providerEventId;
    const open = this.open;
    if (open?.kind === kind && this.assistantIndex !== undefined) {
      const part = this.assistantMessage()?.parts[open.index];
      if ((part?.kind === 'text' || part?.kind === 'thinking') && part.text !== text) {
        this.services.state.mutate(this.runtime, [
          set(['messages', this.assistantIndex, 'parts', open.index, 'text'], text),
        ]);
        this.markDirty();
      }
      this.open = undefined;
      return;
    }
    this.open = undefined;
    if (text.length > 0) this.pushPart({ kind, text });
  }

  /** A warning from the policy that lets the turn go on. The same text is shown once per turn. */
  private addFindingNotice(text: string): void {
    if (this.findingNotices.has(text)) return;
    this.findingNotices.add(text);
    this.addNotice('warning', text);
  }

  private addNotice(level: 'info' | 'warning' | 'error', text: string): void {
    this.pushPart({ kind: 'notice', level, text });
  }

  // ---- tool calls --------------------------------------------------------------------------------------

  private onToolCall(event: ToolCallEvent): void {
    this.sawOutput = true;
    const known = this.toolIndex.get(event.toolCallId);
    if (known !== undefined) {
      this.updateTool(event.toolCallId, { input: event.input });
      return;
    }
    const call: ToolCallView = {
      id: event.toolCallId,
      name: event.name,
      input: event.input,
      inputTruncated:
        isRecord(event.input) && event.input['truncated'] === true && 'preview' in event.input,
      status: this.awaiting.has(event.toolCallId) ? 'awaiting-approval' : 'running',
      parentId: event.parentToolCallId,
      startedAt: this.clock.now(),
    };
    const index = this.pushPart({ kind: 'tool', call });
    this.toolIndex.set(event.toolCallId, index);
    this.openCalls.add(event.toolCallId);
  }

  private onToolResult(event: ToolResultEvent): void {
    this.awaiting.delete(event.toolCallId);
    const status: ToolCallView['status'] = event.notExecuted
      ? event.decision?.outcome === 'reject'
        ? 'denied'
        : 'not-run'
      : event.isError
        ? 'error'
        : 'done';
    let approval: ApprovalSource | undefined;
    if (event.decision?.source === 'provider') approval = 'provider';
    else approval = this.approvals.get(event.toolCallId);
    // The tool ran and nobody on record allowed it: the card says so instead of guessing.
    if (approval === undefined && !event.notExecuted) approval = 'unverified';
    this.updateTool(event.toolCallId, {
      status,
      ...(approval !== undefined ? { approval } : {}),
      resultPreview: event.text,
      resultTruncated: event.truncated,
      endedAt: this.clock.now(),
    });
  }

  private updateTool(toolCallId: string, patch: Partial<ToolCallView>): void {
    const index = this.toolIndex.get(toolCallId);
    if (index === undefined || this.assistantIndex === undefined) {
      this.logger.debug('an event for a tool call that is not shown', {});
      return;
    }
    const part = this.assistantMessage()?.parts[index];
    if (part?.kind !== 'tool') return;
    this.services.state.mutate(this.runtime, [
      set(['messages', this.assistantIndex, 'parts', index, 'call'], { ...part.call, ...patch }),
    ]);
    this.markDirty();
  }

  /** Tools that never reported back are marked as not run once the turn is over. */
  private closeTools(): void {
    const endedAt = this.clock.now();
    for (const [toolCallId, index] of this.toolIndex) {
      const part = this.assistantMessage()?.parts[index];
      if (part?.kind !== 'tool') continue;
      if (part.call.status === 'running' || part.call.status === 'awaiting-approval') {
        this.updateTool(toolCallId, { status: 'not-run', endedAt });
      }
    }
  }

  // ---- permission requests and questions -------------------------------------------------------------

  private async onPermissionRequest(request: PermissionRequest): Promise<PermissionResponse> {
    const id = request.toolCallId;
    this.awaiting.add(id);
    this.openCalls.add(id);
    if (!this.closed) this.setToolStatusIf(id, 'running', 'awaiting-approval');
    await this.notifyPermissionRequest(request);
    let decision: PolicyDecision;
    try {
      decision = await this.services.policy.decide(request, this.policyContext(request.signal));
    } catch (error) {
      this.logger.error('the policy failed to decide on a request', {
        error: redact(String(error)),
      });
      decision = {
        response: { behavior: 'deny', message: TEXT.policyFailed },
        approval: 'policy',
      };
    }
    this.awaiting.delete(id);
    const rule = this.alwaysRules.get(id);
    if (rule !== undefined) {
      this.alwaysRules.delete(id);
      this.services.onAlwaysAllowChosen?.(this.conversationId, this.runtime.data.meta.folder, rule);
    }
    this.approvals.set(id, decision.approval);
    if (decision.response.behavior === 'allow' && !this.closed) {
      this.setToolStatusIf(id, 'awaiting-approval', 'running');
    }
    return decision.response;
  }

  /** Observers see a request first, so they can capture what an approved edit is about to change. */
  private async notifyPermissionRequest(request: PermissionRequest): Promise<void> {
    const context = this.turnContext;
    if (!context) return;
    for (const observer of this.ranBefore) {
      if (!observer.onPermissionRequest) continue;
      try {
        await observer.onPermissionRequest(context, request);
      } catch (error) {
        this.logger.warn('an observer failed on a permission request', {
          error: redact(String(error)),
        });
      }
    }
  }

  private setToolStatusIf(
    toolCallId: string,
    from: ToolCallView['status'],
    to: ToolCallView['status'],
  ): void {
    const index = this.toolIndex.get(toolCallId);
    if (index === undefined) return;
    const part = this.assistantMessage()?.parts[index];
    if (part?.kind === 'tool' && part.call.status === from) {
      this.updateTool(toolCallId, { status: to });
    }
  }

  private policyContext(signal: AbortSignal | undefined): PolicyContext {
    return {
      ...(this.projectConfig ? { projectConfig: this.projectConfig } : {}),
      conversation: this.runtime.data.meta,
      mode: this.input.mode,
      folder: this.input.folder,
      settings: this.input.settings,
      askUser: (prompt) => this.askUser(prompt, signal),
    };
  }

  /** Shows a prompt and waits. See `PendingPrompt.settle` for how it ends. */
  private askUser(
    newPrompt: NewPrompt,
    signal: AbortSignal | undefined,
  ): Promise<PromptAnswer | undefined> {
    if (this.closed || this.cancelRequested || signal?.aborted === true) {
      return Promise.resolve(undefined);
    }
    const { state, store, prompts } = this.services;
    const prompt: Prompt = PromptSchema.parse({
      ...newPrompt,
      id: newId<PromptId>(),
      conversationId: this.conversationId,
      turnId: this.turnId,
      createdAt: this.clock.now(),
      state: 'pending',
      displayHash: displayHashOf(newPrompt),
    });
    state.mutate(this.runtime, [push(['prompts'], prompt)]);
    this.pushPart({ kind: 'prompt', promptId: prompt.id });
    this.track(store.putPrompt(this.conversationId, prompt));
    this.persistMessage();
    state.refreshSummaries();

    return new Promise<PromptAnswer | undefined>((resolve) => {
      const onAbort = (): void => entry.settle('expired');
      const entry: PendingPrompt = {
        prompt,
        answering: false,
        settled: false,
        settle: (next, answer) => {
          if (entry.settled) return;
          entry.settled = true;
          signal?.removeEventListener('abort', onAbort);
          this.entries.delete(entry);
          prompts.delete(prompt.id);
          this.recordPromptState(prompt, next, answer);
          resolve(next === 'answered' ? answer : undefined);
        },
      };
      this.entries.add(entry);
      prompts.set(prompt.id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private recordPromptState(
    prompt: Prompt,
    next: 'answered' | 'expired' | 'cancelled',
    answer: PromptAnswer | undefined,
  ): void {
    const index = this.runtime.data.prompts.findIndex((candidate) => candidate.id === prompt.id);
    const current = this.runtime.data.prompts[index];
    if (!current) return;
    let updated: Prompt = { ...current, state: next };
    if (next === 'answered' && answer) {
      if (current.kind === 'permission' && answer.kind === 'permission') {
        updated = { ...current, state: next, answered: answer.choice };
        // The user asked for a rule: whether the policy managed to keep it is checked once it has decided.
        if (answer.choice === 'allow-always' && current.alwaysRule !== undefined) {
          this.alwaysRules.set(current.toolCallId, current.alwaysRule.rule);
        }
      } else if (current.kind === 'question' && answer.kind === 'question') {
        updated = {
          ...current,
          state: next,
          answered: Object.fromEntries(
            Object.entries(answer.answers).map(([question, values]) => [
              question,
              values.join(', '),
            ]),
          ),
        };
      }
    }
    this.services.state.mutate(this.runtime, [set(['prompts', index], updated)]);
    if (next === 'answered' && answer) this.recordQuestionDecisions(updated, answer);
    this.track(this.services.store.putPrompt(this.conversationId, updated));
    this.services.state.refreshSummaries();
  }

  // ---- state and storage helpers ---------------------------------------------------------------------

  private currentTurn(): Turn | undefined {
    return this.runtime.data.turns.find((turn) => turn.id === this.turnId);
  }

  private setTurn(patch: Partial<Turn>, persist: boolean): void {
    const index = this.runtime.data.turns.findIndex((turn) => turn.id === this.turnId);
    const current = this.runtime.data.turns[index];
    if (!current) return;
    const next: Turn = { ...current, ...patch };
    this.services.state.mutate(this.runtime, [set(['turns', index], next)]);
    if (persist) this.track(this.services.store.putTurn(this.conversationId, next));
  }

  private setActivity(text: string | null): void {
    if (this.closed || this.runtime.data.activity === text) return;
    this.services.state.mutate(this.runtime, [set(['activity'], text)]);
  }

  private async patchMeta(patch: MetaPatch): Promise<void> {
    const next = await this.services.store.updateMeta(this.conversationId, patch);
    this.services.state.mutate(this.runtime, [set(['meta'], next)]);
    this.services.state.refreshSummaries();
  }

  /** Schedules a write of the assistant message; while it keeps changing it is written once a second. */
  private markDirty(): void {
    this.persistTimer ??= setTimeout(() => {
      this.persistTimer = undefined;
      if (!this.closed) this.persistMessage();
    }, PERSIST_INTERVAL_MS);
  }

  private persistMessage(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const message = this.assistantMessage();
    if (message) this.track(this.services.store.putMessage(this.conversationId, message));
  }

  /** Runs a write in the background; a failure is logged and never stops the turn. */
  private track(write: Promise<unknown>): void {
    const tracked = write.then(
      () => undefined,
      (error: unknown) => {
        this.logger.warn('a conversation write failed', { error: redact(String(error)) });
      },
    );
    this.writes.add(tracked);
    void tracked.finally(() => this.writes.delete(tracked));
  }
}

function sanitizeUsage(usage: UsageInfo): UsageInfo {
  const clean: UsageInfo = { ...usage };
  if (clean.contextWindow !== undefined && !(clean.contextWindow > 0)) delete clean.contextWindow;
  return clean;
}
