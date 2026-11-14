import type {
  AgentEvent,
  ApprovalSource,
  ConversationMeta,
  Mode,
  PermissionPrompt,
  PromptAnswer,
  QuestionPrompt,
  Settings,
  TurnId,
  TurnOutcome,
} from '../../shared';
import type { FolderInfo } from './app';
import type { PermissionRequest, PermissionResponse, ToolHookEvent } from './host-tools';
import type { ExecutionProfile, ProjectConfigChoice } from './provider';

type PromptFieldsSetByController =
  'id' | 'conversationId' | 'turnId' | 'createdAt' | 'state' | 'displayHash' | 'answered';

/** A prompt as a policy describes it; the controller adds identity, state and the display hash. */
export type NewPrompt =
  | Omit<PermissionPrompt, PromptFieldsSetByController>
  | Omit<QuestionPrompt, PromptFieldsSetByController>;

export interface PolicyContext {
  conversation: ConversationMeta;
  mode: Mode;
  folder: FolderInfo;
  settings: Settings;
  /**
   * Agent mode's Auto applies to this decision: the turn started with it and it has not been turned
   * off since. It can never become true during a turn.
   */
  auto: boolean;
  /** What the user decided about the project's own Claude Code configuration for this turn. Absent means "ignore both". */
  projectConfig?: ProjectConfigChoice;
  /**
   * Shows a prompt to the user and waits. Resolves `undefined` when the prompt expired or was
   * cancelled (the provider withdrew the request or the turn ended).
   */
  askUser(prompt: NewPrompt): Promise<PromptAnswer | undefined>;
}

export interface PolicyDecision {
  response: PermissionResponse;
  /** Who made the decision, shown on the tool card. */
  approval: ApprovalSource;
}

/** Decides what a turn may do. One implementation per kind of mode; later phases add the real ones. */
export interface TurnPolicy {
  /** The execution profile for a turn, or why this mode cannot run. */
  profile(input: {
    mode: Mode;
    settings: Settings;
    conversation: ConversationMeta;
  }): ExecutionProfile | { unavailable: string };
  decide(request: PermissionRequest, context: PolicyContext): Promise<PolicyDecision>;
  /**
   * Looks at every provider event of the turn. `stop` ends the turn at once and shows the text as
   * the reason (used by the read-only guard). `notice` adds a warning to the turn and lets it go on.
   */
  inspect?(event: AgentEvent, context: PolicyContext): PolicyFinding | undefined;
}

export interface PolicyFinding {
  stop?: string;
  notice?: string;
}

export interface TurnContext {
  conversation: ConversationMeta;
  turnId: TurnId;
  mode: Mode;
  folder: FolderInfo;
  settings: Settings;
}

export interface TurnNotice {
  level: 'info' | 'warning' | 'error';
  text: string;
}

/** Something that needs to act around a turn, such as the read-only tripwire or the change tracker. */
export interface TurnObserver {
  /**
   * Runs after the checks and before the provider process starts, while the turn shows as preparing.
   * Throwing refuses the turn and shows the error's message.
   */
  beforeTurn?(context: TurnContext, signal: AbortSignal): Promise<void>;
  /** Runs after the process has exited, whatever the outcome. Its notices are added to the turn. */
  afterTurn?(context: TurnContext, outcome: TurnOutcome): Promise<TurnNotice[]>;
  /** Whether this observer wants `onToolHook` for the turn (the provider is then asked to call back around every tool). */
  wantsToolHooks?(context: TurnContext): boolean;
  /** The provider process of the turn has started. */
  onProcessStarted?(context: TurnContext, pid: number): void;
  /**
   * A permission request arrived. Awaited before the policy decides, so an observer can capture a
   * file before an edit that is about to be approved. Must not throw for a request it does not understand.
   */
  onPermissionRequest?(context: TurnContext, request: PermissionRequest): Promise<void>;
  /** The provider is about to run, or has just run, a tool. Awaited before the provider continues. */
  onToolHook?(context: TurnContext, event: ToolHookEvent): Promise<void>;
  /**
   * The provider reported the result of a tool call. A denied call has no `post` hook at all, so this
   * is the only signal that it ended. `executed` is false when the tool did not run.
   */
  onToolResult?(
    context: TurnContext,
    result: { toolCallId: string; executed: boolean; isError: boolean },
  ): void;
}
