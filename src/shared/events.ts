/**
 * Provider-neutral events a provider adapter emits during one turn.
 * These are produced by our own mapper from validated provider output, so they are plain types.
 */

export type CredentialKind = 'subscription' | 'api-key' | 'other' | 'unknown';

export type ErrorCategory =
  | 'authentication'
  | 'billing'
  | 'rate-limit'
  | 'overloaded'
  | 'model-not-found'
  | 'invalid-request'
  | 'session-not-found'
  | 'startup'
  | 'process-crash'
  | 'protocol'
  | 'guard'
  | 'unknown';

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The provider's own cost estimate, when it reports one. */
  costUsd?: number;
  /** Context window of the main model, when reported. */
  contextWindow?: number;
  /** Tokens in context at the last main-loop request, when it can be derived. Approximate. */
  contextTokens?: number;
}

export interface SessionEvent {
  type: 'session';
  sessionId: string;
  model: string;
  cliVersion: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  plugins: { name: string; builtin: boolean }[];
  permissionMode: string;
  cwd: string;
  credential: CredentialKind;
}

export interface StatusEvent {
  type: 'status';
  state: 'running' | 'idle' | 'compacting' | 'retrying';
  detail?: string;
}

export interface TextDeltaEvent {
  type: 'text-delta';
  kind: 'text' | 'thinking';
  text: string;
  /** Set when the text belongs to a subagent started by this tool call. */
  parentToolCallId: string | null;
}

/** A completed block of assistant output. Deltas for it, if any, were sent before. */
export interface AssistantBlockEvent {
  type: 'assistant-block';
  kind: 'text' | 'thinking';
  text: string;
  /** The provider's id for this event. For Claude Code it is the cut point for a fork at this turn. */
  providerEventId: string;
  parentToolCallId: string | null;
}

export interface ToolCallEvent {
  type: 'tool-call';
  toolCallId: string;
  name: string;
  input: unknown;
  providerEventId: string;
  parentToolCallId: string | null;
}

export type ToolDecisionSource = 'provider' | 'host' | 'unknown';

export interface ToolResultEvent {
  type: 'tool-result';
  toolCallId: string;
  isError: boolean;
  /** Text shown to the model, possibly truncated by the adapter. */
  text: string;
  truncated: boolean;
  /** Who allowed or refused the call, when the provider reports it. */
  decision?: { outcome: 'accept' | 'reject'; source: ToolDecisionSource };
  /** True when the tool did not run (denied, interrupted). */
  notExecuted: boolean;
  parentToolCallId: string | null;
}

export interface HookEvent {
  type: 'hook';
  phase: 'started' | 'response';
  name: string;
  outcome?: string;
}

export interface RateLimitEvent {
  type: 'rate-limit';
  status: 'allowed' | 'warning' | 'rejected';
  resetsAt?: number;
  limitKind?: string;
}

export interface RetryEvent {
  type: 'retry';
  attempt: number;
  maxRetries: number;
  delayMs: number;
  category: ErrorCategory;
}

export interface ErrorEvent {
  type: 'error';
  category: ErrorCategory;
  /** Human-readable text from the provider or from us. Displayed, never parsed. */
  message: string;
}

export type TurnOutcome = 'completed' | 'interrupted' | 'error' | 'limit';

export interface ResultEvent {
  type: 'result';
  outcome: TurnOutcome;
  isError: boolean;
  category?: ErrorCategory;
  text: string;
  numTurns: number;
  durationMs: number;
  usage?: UsageInfo;
  permissionDenials: { toolName: string; toolCallId: string }[];
  terminalReason?: string;
}

/** An event type this version of the adapter does not know. Kept so nothing is dropped silently. */
export interface UnknownEvent {
  type: 'unknown';
  rawType: string;
}

export type AgentEvent =
  | SessionEvent
  | StatusEvent
  | TextDeltaEvent
  | AssistantBlockEvent
  | ToolCallEvent
  | ToolResultEvent
  | HookEvent
  | RateLimitEvent
  | RetryEvent
  | ErrorEvent
  | ResultEvent
  | UnknownEvent;
