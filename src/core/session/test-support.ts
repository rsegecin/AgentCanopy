import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { z } from 'zod';
import {
  fakeClaude,
  initEvent,
  type FakeClaude,
  type FakeClaudeRecord,
} from '../../../test/fake-cli';
import { DEFAULT_SETTINGS, QuestionSchema, applyPatch } from '../../shared';
import type {
  ActiveConversation,
  Attachment,
  ConversationId,
  FolderKey,
  HostMessage,
  PatchOp,
  ProviderStatus,
  Settings,
  ViewEvent,
  ViewState,
} from '../../shared';
import type {
  AgentProvider,
  AppController,
  Clock,
  EditorPort,
  FolderInfo,
  Logger,
  PermissionRequest,
  PolicyContext,
  PolicyDecision,
  TurnHandle,
  TurnObserver,
  TurnPolicy,
  TurnRequest,
  UiPort,
  ViewHandle,
  ViewSink,
} from '../contracts';
import { createHostToolServer } from '../mcp-host';
import { sha256Hex } from '../util';
import { createClaudeProvider, isAlive } from '../provider/claude';
import { createAppControllerWithInternals } from './controller';
import type { RuleStore } from '../policy/agent';
import type { GrantStore, SavedPermissions } from '../policy';
import type { CheckpointServiceWithChanges } from '../workspace/checkpoints';
import type { ReviewEngine } from '../workspace/review';
import type { WorkspaceTracker } from '../workspace/tracker';
import { modeUnavailable } from './text';

export const FOLDER_KEY = 'folder-1' as FolderKey;

/** A step list for the fake CLI. */
export type Step = Record<string, unknown>;

// ---- a policy for tests ----------------------------------------------------------------------------

const QuestionsSchema = z.array(QuestionSchema).min(1);

async function decideQuestion(
  request: PermissionRequest,
  context: PolicyContext,
): Promise<PolicyDecision> {
  const parsed = QuestionsSchema.safeParse(request.input['questions']);
  if (!parsed.success) {
    return {
      response: { behavior: 'deny', message: 'The question could not be shown.' },
      approval: 'policy',
    };
  }
  const questions = parsed.data;
  const answer = await context.askUser({
    kind: 'question',
    toolCallId: request.toolCallId,
    questions,
  });
  if (answer?.kind !== 'question') {
    return {
      response: { behavior: 'deny', message: 'The user did not answer.' },
      approval: 'policy',
    };
  }
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const values = answer.answers[question.question];
    if (values !== undefined) answers[question.question] = values.join(', ');
  }
  return {
    response: { behavior: 'allow', updatedInput: { ...request.input, answers } },
    approval: 'user',
  };
}

/**
 * A small policy that does not depend on the real one: Ask mode is read-only and answers
 * AskUserQuestion with what the user chose; every other tool is denied; Plan and Agent mode do not run.
 */
export function createTestPolicy(): TurnPolicy {
  return {
    profile({ mode, settings }) {
      if (mode === 'ask') {
        return { kind: 'read-only', webTools: settings.askWebTools, planTool: false };
      }
      return { unavailable: modeUnavailable(mode) };
    },
    decide(request, context) {
      if (request.toolName === 'AskUserQuestion') return decideQuestion(request, context);
      return Promise.resolve({
        response: {
          behavior: 'deny',
          message: `This action is not allowed in ${context.mode} mode.`,
        },
        approval: 'policy',
      });
    },
  };
}

/**
 * The test policy with Plan and Agent mode available: Plan mode is read-only and offers the plan
 * tool unless the conversation's plan is locked; Agent mode is a plain agent profile.
 */
export function createPlanTestPolicy(): TurnPolicy {
  const base = createTestPolicy();
  return {
    ...base,
    profile(input) {
      if (input.mode === 'plan') {
        return {
          kind: 'read-only',
          webTools: input.settings.askWebTools,
          planTool: !input.conversation.planLocked,
        };
      }
      if (input.mode === 'agent') {
        return {
          kind: 'agent',
          allowRules: [],
          alwaysAskCommands: false,
          sandbox: false,
          sandboxLocked: false,
        };
      }
      return base.profile(input);
    },
  };
}

// ---- waiting ----------------------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the condition holds. The description names what was awaited when it never does. */
export async function until(
  description: string,
  condition: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
    await sleep(10);
  }
}

// ---- the view -----------------------------------------------------------------------------------------

/** A view that does what the webview does with host messages: it applies `init` and every `patch`. */
export class TestView implements ViewSink {
  readonly messages: HostMessage[] = [];
  readonly events: ViewEvent[] = [];
  /** Sequence or application problems seen while applying messages. */
  readonly problems: string[] = [];
  state: ViewState | undefined;
  seq = -1;
  handle: ViewHandle | undefined;
  private beforeInit: { state: ViewState | undefined; seq: number } | undefined;

  post(message: HostMessage): void {
    this.messages.push(message);
    switch (message.type) {
      case 'init':
        this.beforeInit = { state: this.state, seq: this.seq };
        this.state = message.state;
        this.seq = message.seq;
        return;
      case 'patch':
        if (this.state === undefined) {
          this.problems.push('a patch arrived before init');
          return;
        }
        if (message.seq !== this.seq + 1) {
          this.problems.push(`patch ${message.seq} after ${this.seq}`);
        }
        this.seq = message.seq;
        this.state = applyPatch(this.state, message.ops);
        return;
      case 'event':
        this.events.push(message.event);
        return;
    }
  }

  send(raw: unknown): void {
    if (!this.handle) throw new Error('the view is not attached');
    this.handle.receive(raw);
  }

  ready(): void {
    this.send({ type: 'ready' });
  }

  current(): ViewState {
    if (!this.state) throw new Error('the view has no state yet');
    return this.state;
  }

  active(): ActiveConversation {
    const { active } = this.current();
    if (!active) throw new Error('the view shows no conversation');
    return active;
  }

  get toasts(): { level: string; text: string }[] {
    return this.events.flatMap((event) =>
      event.kind === 'toast' ? [{ level: event.level, text: event.text }] : [],
    );
  }

  patches(): { seq: number; ops: PatchOp[] }[] {
    return this.messages.flatMap((message) =>
      message.type === 'patch' ? [{ seq: message.seq, ops: message.ops }] : [],
    );
  }

  /**
   * The mirror property: what this view built from `init` and patches equals what the controller
   * sends as a full state when asked. Also checks that no patch arrived out of order.
   */
  expectMirror(): void {
    const count = this.messages.length;
    this.send({ type: 'resync' });
    const last = this.messages[this.messages.length - 1];
    expect(this.messages.length).toBeGreaterThan(count);
    expect(last?.type).toBe('init');
    if (last?.type !== 'init' || !this.beforeInit) throw new Error('no init after resync');
    expect(last.state).toEqual(this.beforeInit.state);
    expect(last.seq).toBe(this.beforeInit.seq);
    expect(this.problems).toEqual([]);
  }

  dispose(): void {
    this.handle?.dispose();
  }
}

// ---- fakes ----------------------------------------------------------------------------------------------

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data: Record<string, unknown> | undefined;
}

export class TestLogger implements Logger {
  readonly entries: LogEntry[] = [];
  private add(level: LogEntry['level'], message: string, data?: Record<string, unknown>): void {
    this.entries.push({ level, message, data });
  }
  debug(message: string, data?: Record<string, unknown>): void {
    this.add('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.add('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.add('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.add('error', message, data);
  }
  has(level: LogEntry['level'], fragment: string): boolean {
    return this.entries.some((e) => e.level === level && e.message.includes(fragment));
  }
}

export class FakeEnv {
  trustedValue = true;
  folderList: FolderInfo[] = [];
  settingsValue: Settings = { ...DEFAULT_SETTINGS };
  storage: string | undefined;
  globalStorage: string | undefined;
  trusted(): boolean {
    return this.trustedValue;
  }
  folders(): FolderInfo[] {
    return this.folderList;
  }
  settings(): Settings {
    return this.settingsValue;
  }
  storageDir(): string | undefined {
    return this.storage;
  }
  globalStorageDir(): string | undefined {
    return this.globalStorage;
  }
}

/** The editor as the controller sees it: only the unsaved files matter to it. */
export class FakeEditor implements EditorPort {
  dirty: string[] = [];
  dirtyFiles(): string[] {
    return this.dirty;
  }
  isDirty(absolutePath: string): boolean {
    return this.dirty.includes(absolutePath);
  }
  private readonly listeners = new Set<(absolutePath: string) => void>();
  onDidSave(listener: (absolutePath: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** The user saves a file in the editor. */
  save(absolutePath: string): void {
    for (const listener of [...this.listeners]) listener(absolutePath);
  }
}

export class FakeUi implements UiPort {
  readonly calls: { name: string; args: unknown[] }[] = [];
  confirmAnswer = true;
  picked: string[] = [];
  selection: Attachment | undefined;
  diagnostics: Attachment | undefined;
  failCopy = false;
  /** Called when a confirmation is asked; the answer waits for it when it returns a promise. */
  onConfirm:
    | ((input: { title: string; detail: string; confirmLabel: string }) => void | Promise<void>)
    | undefined;

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }
  callsOf(name: string): unknown[][] {
    return this.calls.filter((call) => call.name === name).map((call) => call.args);
  }
  confirm(input: { title: string; detail: string; confirmLabel: string }): Promise<boolean> {
    this.record('confirm', input);
    return Promise.resolve(this.onConfirm?.(input)).then(() => this.confirmAnswer);
  }
  pickPaths(input: { what: 'file' | 'folder' }): Promise<string[]> {
    this.record('pickPaths', input.what);
    return Promise.resolve(this.picked);
  }
  currentSelection(): Attachment | undefined {
    this.record('currentSelection');
    return this.selection;
  }
  currentDiagnostics(): Attachment | undefined {
    this.record('currentDiagnostics');
    return this.diagnostics;
  }
  openFile(absolutePath: string, line?: number): Promise<void> {
    this.record('openFile', absolutePath, line);
    return Promise.resolve();
  }
  openExternal(url: string): Promise<void> {
    this.record('openExternal', url);
    return Promise.resolve();
  }
  copyToClipboard(text: string): Promise<void> {
    this.record('copyToClipboard', text);
    if (this.failCopy) return Promise.reject(new Error('the clipboard is not available'));
    return Promise.resolve();
  }
  startSignIn(providerId: string, command?: { executable: string; args: string[] }): void {
    this.record('startSignIn', ...(command ? [providerId, command] : [providerId]));
  }
  openEditorPanel(conversationId?: ConversationId): void {
    this.record('openEditorPanel', conversationId);
  }
  showDiff(input: {
    title: string;
    leftLabel: string;
    leftText: string;
    rightLabel: string;
    rightText: string;
  }): Promise<void> {
    this.record('showDiff', input);
    return Promise.resolve();
  }
  showReadOnlyDocument(input: {
    key: string;
    title: string;
    text: string;
    beside?: boolean;
  }): Promise<void> {
    this.record('showReadOnlyDocument', input);
    return Promise.resolve();
  }
  /** What `choose` answers, one entry per call. An empty list (or `undefined`) means "dismissed". */
  chooseAnswers: (string | undefined)[] = [];
  choose(input: {
    title: string;
    detail: string;
    options: { id: string; label: string }[];
  }): Promise<string | undefined> {
    this.record('choose', input);
    return Promise.resolve(this.chooseAnswers.shift());
  }
  openChangeDiff(folderKey: FolderKey, path: string): Promise<void> {
    this.record('openChangeDiff', folderKey, path);
    return Promise.resolve();
  }
  openAllChanges(folderKey: FolderKey, paths?: readonly string[]): Promise<void> {
    if (paths === undefined) this.record('openAllChanges', folderKey);
    else this.record('openAllChanges', folderKey, paths);
    return Promise.resolve();
  }
  showLogs(): void {
    this.record('showLogs');
  }
  /** What `pickDirectory` answers. `undefined` means "dismissed". */
  directoryAnswer: string | undefined;
  pickDirectory(input: {
    title: string;
    openLabel: string;
    defaultPath?: string;
  }): Promise<string | undefined> {
    this.record('pickDirectory', input);
    return Promise.resolve(this.directoryAnswer);
  }
  openSettings(): void {
    this.record('openSettings');
  }
}

// ---- the harness ------------------------------------------------------------------------------------------

export interface ScenarioSpec {
  scenario: object;
  record?: boolean;
  auth?: object;
}

export interface HarnessOptions {
  /** One scenario for every turn. Default: a CLI that does nothing. */
  scenario?: object;
  record?: boolean;
  auth?: object;
  /** Scenarios by order of `startTurn` calls; the last one repeats. Replaces `scenario`. */
  sequence?: ScenarioSpec[];
  /** Default: `createTestPolicy()`. */
  policy?: TurnPolicy;
  /** Default: none. */
  observers?: TurnObserver[];
  /** Replaces the provider list (the real provider over the fake CLI is the default). */
  providers?: AgentProvider[];
  noFolder?: boolean;
  untrusted?: boolean;
  /** Share the directories of another harness (to open the same storage with a new controller). */
  reuse?: Harness;
  /** Called with every turn request just before the provider starts it. */
  onStartTurn?: (request: TurnRequest) => void;
  /** Build the application without a policy and without observers, so it uses its own defaults. */
  realDefaults?: boolean;
  /** What the editor reports about open files. */
  editor?: EditorPort;
  /** A directory to use as the global storage, to share it between harnesses. */
  globalStorage?: string;
  /** Overrides what the provider reports about cutting a fork at an earlier message. */
  forkAtMessage?: 'exact' | 'none';
  /** The time the application sees. Default: the real one. */
  clock?: Clock;
  /** Ask about the project's own Claude Code configuration before turns. Default: only with the real defaults. */
  projectConfigGate?: boolean;
  /** Do not call `start()`. */
  noStart?: boolean;
}

export interface Harness {
  readonly root: string;
  readonly workspace: string;
  readonly storage: string;
  /** What the environment reports as storage shared by every window. */
  readonly globalStorage: string;
  readonly env: FakeEnv;
  readonly ui: FakeUi;
  readonly logger: TestLogger;
  readonly controller: AppController;
  /** The workspace tracker of the application's own defaults, once started. */
  tracker(): WorkspaceTracker | undefined;
  /** The rule store of the application's own default policy, once started. */
  rules(): RuleStore | undefined;
  /** The grant store of the application's own default policy, once started. */
  grants(): GrantStore | undefined;
  /** Both stores as the Permissions view lists them, once started. */
  saved(): SavedPermissions | undefined;
  /** The review engine of the application's own defaults, once started. */
  engine(): ReviewEngine | undefined;
  /** Asks the application to clean up stored file contents of a folder; resolves when done or skipped. */
  collectGarbage(folderKey: FolderKey): Promise<void>;
  /** The checkpoint service of the application's own defaults, once started. */
  checkpoints(): CheckpointServiceWithChanges | undefined;
  readonly fakes: FakeClaude[];
  /** Every turn handle the provider returned, in order. */
  readonly handles: TurnHandle[];
  readonly requests: TurnRequest[];
  readonly views: TestView[];
  /** Attaches a view and, by default, sends `ready`. */
  attach(options?: {
    ready?: boolean;
    conversationId?: ConversationId;
    kind?: 'sidebar' | 'panel';
  }): TestView;
  /** Reads what the fake CLI recorded on its latest run (needs `record`). */
  record(index?: number): Promise<FakeClaudeRecord>;
  /** Waits until no turn runs any more. */
  idle(): Promise<void>;
  dispose(): Promise<void>;
}

function trackedProvider(
  providers: AgentProvider[],
  handles: TurnHandle[],
  requests: TurnRequest[],
  onStartTurn?: (request: TurnRequest) => void,
  forkAtMessage?: 'exact' | 'none',
): AgentProvider {
  const first = providers[0];
  if (!first) throw new Error('no provider');
  let calls = 0;
  return {
    id: first.id,
    displayName: first.displayName,
    detect: async (signal) => {
      const status = await first.detect(signal);
      return forkAtMessage === undefined
        ? status
        : { ...status, capabilities: { ...status.capabilities, forkAtMessage } };
    },
    listModels: (custom, known) => first.listModels(custom, known),
    startTurn(request) {
      const provider = providers[Math.min(calls, providers.length - 1)] ?? first;
      calls += 1;
      onStartTurn?.(request);
      const handle = provider.startTurn(request);
      handles.push(handle);
      requests.push(request);
      return handle;
    },
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root =
    options.reuse?.root ?? (await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agc-session-'))));
  const workspace = options.reuse?.workspace ?? join(root, 'work');
  const storage = options.reuse?.storage ?? join(root, 'storage');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(storage, { recursive: true });

  const env = new FakeEnv();
  env.trustedValue = options.untrusted !== true;
  env.folderList = options.noFolder ? [] : [{ key: FOLDER_KEY, name: 'work', path: workspace }];
  env.storage = storage;
  // Each harness has its own global storage; one that reuses another's directories shares it, and a
  // test can name a directory to share between independent harnesses.
  const globalStorage =
    options.globalStorage ?? options.reuse?.globalStorage ?? join(root, 'global-storage');
  await fs.mkdir(globalStorage, { recursive: true });
  env.globalStorage = globalStorage;
  const ui = new FakeUi();
  const logger = new TestLogger();
  const handles: TurnHandle[] = [];
  const requests: TurnRequest[] = [];
  const fakes: FakeClaude[] = [];

  let providerList: AgentProvider[];
  if (options.providers) {
    providerList = options.providers;
  } else {
    const specs: ScenarioSpec[] = options.sequence ?? [
      {
        scenario: options.scenario ?? { steps: [] },
        ...(options.record !== undefined ? { record: options.record } : {}),
        ...(options.auth !== undefined ? { auth: options.auth } : {}),
      },
    ];
    const real: AgentProvider[] = [];
    for (const spec of specs) {
      const fake = await fakeClaude(spec.scenario, {
        record: spec.record === true,
        ...(spec.auth !== undefined ? { auth: spec.auth } : {}),
      });
      fakes.push(fake);
      real.push(
        createClaudeProvider({
          claudePath: () => '',
          env: () => fake.env,
          launchOverride: fake.launch,
          interruptGraceMs: 300,
          terminateGraceMs: 300,
        }),
      );
    }
    providerList = [
      trackedProvider(real, handles, requests, options.onStartTurn, options.forkAtMessage),
    ];
  }
  const hostTools = createHostToolServer();
  const { controller, internals } = createAppControllerWithInternals(
    {
      env,
      ui,
      providers: { list: () => providerList, get: (id) => providerList.find((p) => p.id === id) },
      hostTools,
      logger,
      ...(options.editor ? { editor: options.editor } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.realDefaults
        ? {}
        : { policy: options.policy ?? createTestPolicy(), observers: options.observers ?? [] }),
    },
    options.projectConfigGate === undefined ? {} : { projectConfigGate: options.projectConfigGate },
  );
  const views: TestView[] = [];
  let disposed = false;

  const harness: Harness = {
    root,
    workspace,
    storage,
    globalStorage,
    env,
    ui,
    logger,
    controller,
    tracker: () => internals.tracker(),
    rules: () => internals.rules(),
    grants: () => internals.grants(),
    saved: () => internals.saved(),
    engine: () => internals.reviewEngine(),
    checkpoints: () => internals.checkpointService(),
    collectGarbage: (folderKey) => internals.collectGarbage(folderKey),
    fakes,
    handles,
    requests,
    views,
    attach(attachOptions = {}) {
      const view = new TestView();
      view.handle = controller.attachView(
        attachOptions.kind ?? 'sidebar',
        view,
        attachOptions.conversationId ? { conversationId: attachOptions.conversationId } : undefined,
      );
      views.push(view);
      if (attachOptions.ready !== false) view.ready();
      return view;
    },
    async record(index = fakes.length - 1) {
      const path = fakes[index]?.recordPath;
      if (!path) throw new Error('this fake CLI does not record');
      return JSON.parse(await fs.readFile(path, 'utf8')) as FakeClaudeRecord;
    },
    idle: () => until('no turn running', () => controller.runningTurns() === 0),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await controller.dispose();
      for (const view of views) view.dispose();
      for (const handle of handles) {
        await Promise.race([handle.done, sleep(5000)]);
        if (handle.pid !== undefined) expect(isAlive(handle.pid)).toBe(false);
      }
      for (const fake of fakes) await fake.dispose();
      if (!options.reuse) await fs.rm(root, { recursive: true, force: true });
    },
  };
  if (!options.noStart) await controller.start();
  return harness;
}

// ---- scenario pieces ------------------------------------------------------------------------------------------

const BASE = { session_id: '$SESSION', parent_tool_use_id: null };

function streamEvent(event: object): Step {
  return {
    emit: { type: 'stream_event', event, ...BASE, uuid: randomUUID(), api_message_id: 'msg_fake' },
  };
}

export function stateEvent(state: 'running' | 'idle'): Step {
  return {
    emit: {
      type: 'system',
      subtype: 'session_state_changed',
      state,
      uuid: randomUUID(),
      session_id: '$SESSION',
    },
  };
}

/** A text answer streamed in `chunks`, ended by the block with the full text. No result. */
export function streamedText(chunks: string[], options: { pauseMs?: number } = {}): Step[] {
  const steps: Step[] = [
    stateEvent('running'),
    initEvent(),
    streamEvent({
      type: 'message_start',
      message: { id: 'msg_fake', role: 'assistant', content: [] },
    }),
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  ];
  for (const chunk of chunks) {
    steps.push(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunk },
      }),
    );
    if (options.pauseMs) steps.push({ sleep: options.pauseMs });
  }
  steps.push(assistantText(chunks.join('')));
  steps.push(
    streamEvent({ type: 'content_block_stop', index: 0 }),
    streamEvent({ type: 'message_stop' }),
  );
  return steps;
}

export function assistantText(text: string, uuid: string = randomUUID()): Step {
  return {
    emit: {
      type: 'assistant',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      ...BASE,
      uuid,
    },
  };
}

export function assistantToolUse(
  id: string,
  name: string,
  input: object,
  parentToolUseId: string | null = null,
): Step {
  return {
    emit: {
      type: 'assistant',
      message: {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
      ...BASE,
      parent_tool_use_id: parentToolUseId,
      uuid: randomUUID(),
    },
  };
}

/** One streamed piece of text or thinking. `parent` marks it as coming from a subagent. */
export function delta(
  kind: 'text' | 'thinking',
  value: string,
  parent: string | null = null,
): Step {
  const step = streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta:
      kind === 'text'
        ? { type: 'text_delta', text: value }
        : { type: 'thinking_delta', thinking: value },
  }) as { emit: Record<string, unknown> };
  return { emit: { ...step.emit, parent_tool_use_id: parent } };
}

/** A completed block of text or thinking. */
export function block(
  kind: 'text' | 'thinking',
  value: string,
  options: { uuid?: string; parent?: string | null } = {},
): Step {
  return {
    emit: {
      type: 'assistant',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        content: [
          kind === 'text' ? { type: 'text', text: value } : { type: 'thinking', thinking: value },
        ],
      },
      ...BASE,
      parent_tool_use_id: options.parent ?? null,
      uuid: options.uuid ?? randomUUID(),
    },
  };
}

export function userToolResult(
  id: string,
  text: string,
  options: {
    isError?: boolean;
    decision?: { decision: 'accept' | 'reject'; source: string };
    nonExecutionKind?: string;
  } = {},
): Step {
  return {
    emit: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: text,
            ...(options.isError ? { is_error: true } : {}),
          },
        ],
      },
      ...BASE,
      uuid: randomUUID(),
      tool_result_meta: [
        {
          id,
          ...(options.decision ? { permission_decision: options.decision } : {}),
          ...(options.nonExecutionKind ? { non_execution_kind: options.nonExecutionKind } : {}),
        },
      ],
    },
  };
}

export function resultStep(text = '', overrides: Record<string, unknown> = {}): Step[] {
  return [
    {
      emit: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        num_turns: 1,
        stop_reason: 'end_turn',
        terminal_reason: 'completed',
        session_id: '$SESSION',
        uuid: randomUUID(),
        ...overrides,
      },
    },
    stateEvent('idle'),
  ];
}

/** A whole answer: running state, init, streamed text, result. */
export function textScenario(text: string): { steps: Step[] } {
  return { steps: [...streamedText([text]), ...resultStep(text)] };
}

/** The lines of a recorded CLI run as fake CLI steps, with the session and folder filled in by the fake. */
export function fixtureSteps(name: string): Step[] {
  const path = fileURLToPath(new URL(`../../../test/fixtures/cli/${name}.ndjson`, import.meta.url));
  const refit = (value: unknown, key?: string): unknown => {
    if (key === 'session_id') return '$SESSION';
    if (key === 'cwd') return '$CWD';
    if (Array.isArray(value)) return value.map((item) => refit(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, refit(v, k)]),
      );
    }
    return value;
  };
  return readFileLines(path).map((line) => ({
    emit: refit(JSON.parse(line) as unknown) as object,
  }));
}

function readFileLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

export function lastTurn(view: TestView) {
  const turns = view.active().turns;
  const turn = turns[turns.length - 1];
  if (!turn) throw new Error('the conversation has no turn');
  return turn;
}

/** Waits until the view's conversation has a finished last turn and no turn runs. */
export async function finishedTurn(harness: Harness, view: TestView) {
  await until(
    'the turn to finish',
    () => {
      const turns = view.state?.active?.turns ?? [];
      const last = turns[turns.length - 1];
      return (
        harness.controller.runningTurns() === 0 &&
        last !== undefined &&
        last.status !== 'running' &&
        last.status !== 'preparing'
      );
    },
    10_000,
  );
  return lastTurn(view);
}

/** Sends a message to start a conversation (or continue the open one) and returns once it has finished. */
export async function sendAndFinish(
  harness: Harness,
  view: TestView,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'ask',
    model: 'default',
    ...extra,
  });
  await until('the conversation to be shown', () => view.state?.active !== null);
  return finishedTurn(harness, view);
}

export function providerStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    providerId: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    version: '2.1.322',
    meetsMinimum: true,
    minimumVersion: '2.1.295',
    auth: 'signed-in',
    credential: 'subscription',
    capabilities: {
      streaming: true,
      resume: true,
      forkWhole: true,
      forkAtMessage: 'none',
      modelSelection: true,
      interactiveApproval: true,
      readOnlyEnforcement: 'tool-layer',
      cancellation: 'graceful',
      toolEvents: true,
      interactiveQuestions: true,
      usage: true,
      hostTools: true,
      sandbox: true,
      sessionHistory: false,
    },
    problems: [],
    ...overrides,
  };
}

/** A provider that answers detection with a fixed status and cannot run turns. */
export function stubProvider(status: ProviderStatus): AgentProvider {
  return {
    id: status.providerId,
    displayName: status.displayName,
    detect: () => Promise.resolve(status),
    listModels: () => [{ id: 'default', label: 'Default', custom: false }],
    startTurn: () => {
      throw new Error('the stub provider cannot run turns');
    },
  };
}

// ---- images -------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The bytes of a small image: a real PNG signature, then `seed` as filler so each seed is a different image. */
export function pngBytes(seed = 'one', size = 0): Buffer {
  const body = Buffer.from(seed);
  const filler = Buffer.alloc(Math.max(0, size - PNG_SIGNATURE.length - body.length), 0x2a);
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), body, filler]);
}

/** The webview message that pastes an image. */
export function pasteImageMessage(
  bytes: Uint8Array,
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/png',
): { type: 'context.pasteImage'; mediaType: string; data: string } {
  return { type: 'context.pasteImage', mediaType, data: Buffer.from(bytes).toString('base64') };
}

/** The reference a paste puts in the draft: the id is the sha256 of the bytes. */
export function imageReference(
  bytes: Uint8Array,
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/png',
): Attachment {
  return { kind: 'image', id: sha256Hex(bytes), mediaType, bytes: bytes.length };
}
