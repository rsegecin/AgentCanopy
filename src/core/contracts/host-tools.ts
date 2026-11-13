import type { HostEndpoint } from './provider';

export const HOST_SERVER_NAME = 'agentcanopy';
export const PERMISSION_TOOL = 'permission_prompt';
export const PLAN_TOOL = 'submit_plan';

/** The provider asks whether a tool call may run. */
export interface PermissionRequest {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Aborts when the provider cancels the request or its connection closes. A late answer is then ignored. */
  signal: AbortSignal;
}

export type PermissionResponse =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** The provider is about to run, or has just run, a tool call. */
export interface ToolHookEvent {
  phase: 'pre' | 'post';
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Only for `post`: the provider reported that the tool call failed. */
  failed?: boolean;
}

export interface ToolTextResult {
  text: string;
  isError: boolean;
}

/** What the turn orchestrator supplies for one turn. Every call is untrusted input. */
export interface TurnHostHandlers {
  onPermissionRequest(request: PermissionRequest): Promise<PermissionResponse>;
  /** Awaited before the provider continues, so a pre-hook can capture state first. */
  onToolHook?(event: ToolHookEvent): Promise<void>;
  onPlanSubmitted?(input: unknown): Promise<ToolTextResult>;
}

export interface TurnRegistration {
  readonly endpoint: HostEndpoint;
  /** Revokes the token and fails any request still pending. */
  dispose(): void;
}

export interface HostToolServer {
  /** Starts listening on the loopback interface. Idempotent. */
  start(): Promise<void>;
  registerTurn(
    handlers: TurnHostHandlers,
    options: {
      /** JSON Schema of the plan tool's input. Present exposes the tool for this turn. */
      planToolInputSchema?: Record<string, unknown>;
      toolHooks: boolean;
    },
  ): TurnRegistration;
  stop(): Promise<void>;
}
