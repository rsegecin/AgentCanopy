import { z } from 'zod';
import { HOST_SERVER_NAME } from '../contracts';

export type JsonRpcId = string | number | null;

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  cancelled: -32800,
} as const;

export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
export const SERVER_VERSION = '1';

/** Permission requests for the host's own tools are never approved through the prompt. */
export const OWN_TOOL_PREFIX = `mcp__${HOST_SERVER_NAME}__`;

export const PERMISSION_TOOL_DESCRIPTION =
  'Internal. Called by the Claude Code runtime to request approval. Not for the assistant to call.';

export const PERMISSION_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    tool_name: { type: 'string' },
    input: { type: 'object' },
    tool_use_id: { type: 'string' },
  },
  required: ['tool_name', 'input'],
  additionalProperties: true,
} as const;

export const PLAN_TOOL_DESCRIPTION =
  "Save the plan for the user to review. Send the complete plan every time; it replaces the previous version. Choices that are the user's to make are asked with AskUserQuestion before this call, and the plan follows the answers instead of listing them as decision points or open questions. After it succeeds, tell the user in two or three sentences what the plan covers or what changed, and do not repeat the plan in chat.";

export const permissionArgumentsSchema = z.object({
  tool_name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  // Checked by hand: a missing or non-string id falls back to the request's _meta.
  tool_use_id: z.unknown().optional(),
});

export const hookBodySchema = z.object({
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.unknown(),
  // Checked by hand: a value of another type must not make the whole body malformed.
  cwd: z.unknown().optional(),
  agent_id: z.unknown().optional(),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isProgressToken(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

export function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function textResult(text: string, isError?: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    ...(isError === undefined ? {} : { isError }),
  };
}

/** One message in a Streamable HTTP event stream. */
export function sseMessage(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}
