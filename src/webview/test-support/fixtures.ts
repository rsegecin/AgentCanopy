import { act } from '@testing-library/react';
import { EMPTY_VIEW_STATE, HostMessageSchema, WebviewMessageSchema } from '../../shared';
import type {
  ActiveConversation,
  AssistantMessage,
  ConversationId,
  ConversationSummary,
  FolderKey,
  HostMessage,
  MessageId,
  MessagePart,
  PermissionPrompt,
  PlanContent,
  PlanDoc,
  PlanId,
  PlanVersion,
  CheckpointSummary,
  ConfigChange,
  RestoreItem,
  RestorePreview,
  Hunk,
  ReviewEntry,
  PromptId,
  ProviderStatus,
  QuestionPrompt,
  ToolCallView,
  Turn,
  TurnId,
  UserMessage,
  ViewState,
  WebviewMessage,
} from '../../shared';
import type { Host } from '../app/host';

export const convId = (s: string) => s as ConversationId;
export const msgId = (s: string) => s as MessageId;
export const turnId = (s: string) => s as TurnId;

/** A host double. It validates what the app posts, so tests also prove the messages are valid. */
export class FakeHost implements Host {
  readonly posted: WebviewMessage[] = [];
  saved: unknown = undefined;
  private listeners = new Set<(m: HostMessage) => void>();

  constructor(saved?: unknown) {
    this.saved = saved;
  }

  post = (message: WebviewMessage): void => {
    this.posted.push(WebviewMessageSchema.parse(message));
  };

  subscribe = (listener: (m: HostMessage) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): unknown => this.saved;
  setState = (state: unknown): void => {
    this.saved = state;
  };

  /** Delivers a message as the extension host would, inside `act`. The message must be valid. */
  emit(message: HostMessage): void {
    const parsed = HostMessageSchema.parse(message);
    act(() => {
      for (const listener of [...this.listeners]) listener(parsed);
    });
  }

  /** Delivers without validation, for the invalid-message cases. */
  emitRaw(message: unknown): void {
    act(() => {
      for (const listener of [...this.listeners]) listener(message as HostMessage);
    });
  }

  postedOf<T extends WebviewMessage['type']>(type: T): Extract<WebviewMessage, { type: T }>[] {
    return this.posted.filter((m): m is Extract<WebviewMessage, { type: T }> => m.type === type);
  }
}

export function makeProvider(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    providerId: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    version: '2.1.0',
    meetsMinimum: true,
    minimumVersion: '2.0.0',
    auth: 'signed-in',
    credential: 'subscription',
    capabilities: {
      streaming: true,
      resume: true,
      forkWhole: true,
      forkAtMessage: 'exact',
      modelSelection: true,
      interactiveApproval: true,
      readOnlyEnforcement: 'tool-layer',
      cancellation: 'graceful',
      toolEvents: true,
      interactiveQuestions: true,
      usage: true,
      hostTools: true,
      sandbox: false,
      sessionHistory: true,
    },
    problems: [],
    ...over,
  };
}

export function makeSummary(
  id: string,
  over: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id: convId(id),
    title: `Conversation ${id}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    folder: 'folder-1' as FolderKey,
    providerId: 'claude-code',
    model: 'default',
    mode: 'ask',
    planLocked: false,
    preview: '',
    running: false,
    pendingPrompts: 0,
    ...over,
  };
}

export function userMessage(
  id: string,
  text: string,
  over: Partial<UserMessage> = {},
): UserMessage {
  return {
    role: 'user',
    id: msgId(id),
    turnId: turnId('t1'),
    createdAt: 1_700_000_000_000,
    text,
    mode: 'ask',
    attachments: [],
    ...over,
  };
}

export function assistantMessage(
  id: string,
  parts: MessagePart[],
  over: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    id: msgId(id),
    turnId: turnId('t1'),
    createdAt: 1_700_000_000_000,
    parts,
    ...over,
  };
}

export function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: turnId('t1'),
    mode: 'ask',
    model: 'default',
    startedAt: 1_700_000_000_000,
    status: 'completed',
    ...over,
  };
}

export function makeActive(
  id: string,
  over: Partial<Omit<ActiveConversation, 'meta'>> & {
    meta?: Partial<ActiveConversation['meta']>;
  } = {},
): ActiveConversation {
  const { meta, ...rest } = over;
  const base: Partial<ConversationSummary> = makeSummary(id);
  delete base.preview;
  delete base.running;
  delete base.pendingPrompts;
  return {
    meta: { ...(base as ActiveConversation['meta']), ...meta },
    turns: [],
    messages: [],
    prompts: [],
    plan: null,
    activity: null,
    ...rest,
  };
}

export function makeState(over: Partial<ViewState> = {}): ViewState {
  return {
    ...EMPTY_VIEW_STATE,
    trusted: true,
    folders: [{ key: 'folder-1' as FolderKey, name: 'project' }],
    provider: makeProvider(),
    models: [
      { id: 'default', label: 'Default', custom: false },
      { id: 'opus', label: 'Opus', custom: false },
    ],
    defaults: { mode: 'ask', model: 'default' },
    ...over,
  };
}

export const promptId = (s: string) => s as PromptId;

const promptBase = {
  conversationId: convId('c1'),
  turnId: turnId('t1'),
  toolCallId: 'toolu_p',
  createdAt: 1_700_000_000_000,
  state: 'pending' as const,
};

/** The question from the recording Q1 (`AskUserQuestion`) unless `over` says otherwise. */
export function makeQuestionPrompt(
  id: string,
  over: Partial<Omit<QuestionPrompt, 'kind'>> = {},
): QuestionPrompt {
  return {
    ...promptBase,
    id: promptId(id),
    displayHash: `hash-${id}`,
    kind: 'question',
    questions: [
      {
        question: 'Which colour do you prefer?',
        header: 'Colour',
        options: [
          { label: 'Red', description: 'Choose red' },
          { label: 'Blue', description: 'Choose blue' },
        ],
        multiSelect: false,
      },
    ],
    ...over,
  };
}

export function makePermissionPrompt(
  id: string,
  over: Partial<Omit<PermissionPrompt, 'kind'>> = {},
): PermissionPrompt {
  return {
    ...promptBase,
    id: promptId(id),
    displayHash: `hash-${id}`,
    kind: 'permission',
    toolName: 'Bash',
    category: 'command',
    title: 'Run a terminal command',
    detail: "printf 'hello' > /work/a.txt && cat /work/a.txt",
    inputPreview: '{\n  "command": "printf hello"\n}',
    choices: ['allow-once', 'allow-always', 'deny'],
    ...over,
  };
}

export function makeToolCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: 'toolu_1',
    name: 'Bash',
    input: { command: 'npm test' },
    inputTruncated: false,
    status: 'done',
    parentId: null,
    startedAt: 1,
    ...over,
  };
}

export const planId = (s: string) => s as PlanId;

/** A plan version with every section filled, two stages that depend on each other, and one of each kind of question. */
export function makePlanContent(over: Partial<PlanContent> = {}): PlanContent {
  return {
    title: 'Add caching',
    objective: 'Make **reads** fast.',
    requirements: ['Keep the API', 'No new services'],
    analysis: 'The hot path is `load()`.',
    architecture: 'A small cache in front of the store.',
    relevantFiles: [
      { path: 'src/cache.ts', action: 'create', role: 'The cache' },
      { path: 'src/store.ts', action: 'modify', role: 'Uses the cache' },
    ],
    stages: [
      {
        id: 'build',
        title: 'Build the cache',
        description: 'Write it.',
        files: ['src/cache.ts'],
        dependsOn: [],
        acceptance: ['Unit tests pass'],
      },
      {
        id: 'wire',
        title: 'Wire it in',
        description: 'Use it.',
        files: ['src/store.ts'],
        dependsOn: ['build'],
        acceptance: ['Reads hit the cache'],
      },
    ],
    dependencies: ['lru-cache'],
    diagrams: [{ id: 'flow', title: 'Read flow', mermaid: 'sequenceDiagram\n  A->>B: read' }],
    alternatives: [
      {
        id: 'redis',
        title: 'Use Redis',
        summary: 'A shared cache.',
        pros: ['Shared'],
        cons: ['New service'],
        chosen: false,
      },
      { id: 'memory', title: 'In-memory', summary: 'Simple.', pros: [], cons: [], chosen: true },
    ],
    decisionPoints: [
      {
        id: 'eviction',
        question: 'Which eviction policy?',
        options: [
          { id: 'lru', label: 'LRU', description: 'Least recently used' },
          { id: 'ttl', label: 'TTL', description: '' },
        ],
        recommendedOptionId: 'lru',
      },
    ],
    openQuestions: [
      {
        id: 'size',
        question: 'How big can the cache be?',
        kind: 'single',
        options: [
          { id: 'small', label: 'Small', description: '' },
          { id: 'large', label: 'Large', description: '' },
        ],
      },
      {
        id: 'keys',
        question: 'Which keys are cached?',
        kind: 'multi',
        options: [
          { id: 'user', label: 'User', description: '' },
          { id: 'org', label: 'Org', description: '' },
          { id: 'repo', label: 'Repo', description: '' },
        ],
      },
      { id: 'notes', question: 'Anything else?', kind: 'text', options: [] },
    ],
    testingStrategy: 'Unit tests and a soak test.',
    acceptanceCriteria: ['Reads are 2x faster'],
    changeSummary: '',
    ...over,
  };
}

export function makePlanVersion(version: number, over: Partial<PlanVersion> = {}): PlanVersion {
  return {
    version,
    author: 'agent',
    createdAt: 1_700_000_000_000 + version * 60_000,
    content: makePlanContent(),
    contentHash: `hash-v${String(version)}`,
    ...over,
  };
}

export function makePlanDoc(over: Partial<PlanDoc> = {}): PlanDoc {
  return {
    id: planId('plan1'),
    conversationId: convId('c1'),
    createdAt: 1_700_000_000_000,
    versions: [makePlanVersion(1)],
    decisions: [],
    approvals: [],
    ...over,
  };
}

export function makeReviewEntry(path: string, over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    path: path,
    changeType: 'modified',
    attribution: 'agent-tool',
    status: 'pending',
    baseline: { kind: 'file', size: 10, mode: 420, stored: true, binary: false },
    current: { kind: 'file', size: 12, mode: 420, stored: true, binary: false },
    restorable: true,
    includesUserEdits: false,
    operationIds: [],
    ...over,
  };
}

export function makeHunk(index: number, over: Partial<Hunk> = {}): Hunk {
  return {
    id: `hunk-${String(index)}`,
    index,
    baselineStart: index * 10,
    baselineLines: ['old\n'],
    currentStart: index * 10,
    currentLines: ['new\n'],
    ...over,
  };
}

export function makeConfigChange(id: string, over: Partial<ConfigChange> = {}): ConfigChange {
  return {
    id,
    displayPath: '.claude/settings.json',
    changeType: 'modified',
    revertible: true,
    detectedAt: 1_700_000_000_000,
    ...over,
  };
}

export function makeCheckpoint(
  id: string,
  over: Partial<CheckpointSummary> = {},
): CheckpointSummary {
  return {
    operationId: id as CheckpointSummary['operationId'],
    kind: 'agent-turn',
    at: 1_700_000_000_000,
    filesChanged: 2,
    interrupted: false,
    ...over,
  };
}

export function makeRestoreItem(path: string, over: Partial<RestoreItem> = {}): RestoreItem {
  return {
    path: path,
    action: 'write',
    attribution: 'agent-tool',
    selectedByDefault: true,
    selectable: true,
    ...over,
  };
}

export function makeRestorePreview(over: Partial<RestorePreview> = {}): RestorePreview {
  return {
    token: 'tok-1',
    targetOperationId: 'op1' as RestorePreview['targetOperationId'],
    affectedOperations: [],
    items: [],
    bytesNeeded: 0,
    ...over,
  };
}
