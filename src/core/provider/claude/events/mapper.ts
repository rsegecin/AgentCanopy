import type { z } from 'zod';
import type {
  AgentEvent,
  ErrorCategory,
  ResultEvent,
  ToolResultEvent,
  TurnOutcome,
  UsageInfo,
} from '../../../../shared';
import {
  categoryFromApiStatus,
  categoryFromErrorString,
  credentialFromApiKeySource,
} from './categories';
import {
  RawApiRetrySchema,
  RawAssistantSchema,
  RawBaseSchema,
  RawContentDeltaSchema,
  RawHookSchema,
  RawInitSchema,
  RawRateLimitSchema,
  RawResultSchema,
  RawSessionStateSchema,
  RawStatusSchema,
  RawStreamEventSchema,
  RawTextBlockSchema,
  RawThinkingBlockSchema,
  RawToolResultBlockSchema,
  RawToolUseBlockSchema,
  RawUserSchema,
} from './raw';

export interface ClaudeEventMapperOptions {
  /** True when the turn resumes an existing session (decides the category of a startup failure). */
  resuming: boolean;
  /** Longest tool result text kept. Default 20000. */
  maxToolResultChars?: number;
  /** Longest serialised tool input kept. Default 20000. */
  maxToolInputChars?: number;
}

export interface ClaudeProcessExit {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  spawnError?: string;
  cancelled: boolean;
  /** Output lines the line reader had to drop (too long, for example). */
  droppedLines: number;
}

export interface ClaudeEventMapper {
  /** Translates one NDJSON line into zero or more events. Never throws. */
  push(line: string): AgentEvent[];
  /** Called once when the process has ended. Adds a synthetic ending when no result was seen. */
  finish(exit: ClaudeProcessExit): AgentEvent[];
}

const DEFAULT_MAX_CHARS = 20000;

/** Keeps an event type name short and plain before it is shown in a message or an event. */
function safeKind(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

function protocolError(kind: string): AgentEvent {
  return {
    type: 'error',
    category: 'protocol',
    message: `Claude Code sent a "${safeKind(kind)}" event that could not be read.`,
  };
}

export function createClaudeEventMapper(options: ClaudeEventMapperOptions): ClaudeEventMapper {
  const maxResultChars = options.maxToolResultChars ?? DEFAULT_MAX_CHARS;
  const maxInputChars = options.maxToolInputChars ?? DEFAULT_MAX_CHARS;

  let sawInit = false;
  let sawResult = false;
  let initModel: string | undefined;
  let contextTokens: number | undefined;
  const reportedUnknown = new Set<string>();

  function unknownOnce(kind: string): AgentEvent[] {
    const rawType = safeKind(kind);
    if (reportedUnknown.has(rawType)) return [];
    reportedUnknown.add(rawType);
    return [{ type: 'unknown', rawType }];
  }

  function parse<T extends z.ZodType>(
    schema: T,
    value: unknown,
    kind: string,
  ): { ok: true; data: z.infer<T> } | { ok: false; events: AgentEvent[] } {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, events: [protocolError(kind)] };
  }

  function mapSystem(subtype: string | undefined, raw: unknown): AgentEvent[] {
    switch (subtype) {
      case 'init': {
        const r = parse(RawInitSchema, raw, 'system/init');
        if (!r.ok) return r.events;
        const d = r.data;
        sawInit = true;
        initModel = d.model;
        return [
          {
            type: 'session',
            sessionId: d.session_id,
            model: d.model ?? '',
            cliVersion: d.claude_code_version ?? '',
            tools: d.tools ?? [],
            mcpServers: (d.mcp_servers ?? []).map((s) => ({
              name: s.name,
              status: s.status ?? 'unknown',
            })),
            plugins: (d.plugins ?? []).map((p) => ({
              name: p.name,
              builtin: p.path === 'builtin',
            })),
            permissionMode: d.permissionMode ?? '',
            cwd: d.cwd ?? '',
            credential: credentialFromApiKeySource(d.apiKeySource),
          },
        ];
      }
      case 'session_state_changed': {
        const r = parse(RawSessionStateSchema, raw, 'system/session_state_changed');
        if (!r.ok) return r.events;
        if (r.data.state === 'running' || r.data.state === 'idle') {
          return [{ type: 'status', state: r.data.state }];
        }
        return [];
      }
      case 'status': {
        const r = parse(RawStatusSchema, raw, 'system/status');
        if (!r.ok) return r.events;
        const status = r.data.status;
        if (typeof status === 'string') {
          return [
            {
              type: 'status',
              state: status === 'compacting' ? 'compacting' : 'running',
              detail: status,
            },
          ];
        }
        return [{ type: 'status', state: 'running' }];
      }
      case 'api_retry': {
        const r = parse(RawApiRetrySchema, raw, 'system/api_retry');
        if (!r.ok) return r.events;
        return [
          {
            type: 'retry',
            attempt: r.data.attempt ?? 0,
            maxRetries: r.data.max_retries ?? 0,
            delayMs: r.data.retry_delay_ms ?? 0,
            category: categoryFromErrorString(r.data.error),
          },
        ];
      }
      case 'hook_started':
      case 'hook_response': {
        const r = parse(RawHookSchema, raw, `system/${subtype}`);
        if (!r.ok) return r.events;
        const outcome = r.data.outcome;
        return [
          {
            type: 'hook',
            phase: subtype === 'hook_started' ? 'started' : 'response',
            name: r.data.hook_name ?? r.data.hook_event ?? '',
            ...(typeof outcome === 'string' ? { outcome } : {}),
          },
        ];
      }
      case 'compact_boundary':
        return [{ type: 'status', state: 'compacting', detail: 'compact_boundary' }];
      default:
        return unknownOnce(subtype === undefined ? 'system' : `system/${subtype}`);
    }
  }

  function mapStreamEvent(raw: unknown): AgentEvent[] {
    const r = parse(RawStreamEventSchema, raw, 'stream_event');
    if (!r.ok) return r.events;
    const { event, parent_tool_use_id } = r.data;
    if (event.type !== 'content_block_delta') return [];
    const d = parse(RawContentDeltaSchema, event.delta, 'stream_event');
    if (!d.ok) return d.events;
    const delta = d.data;
    const parentToolCallId = parent_tool_use_id ?? null;
    if (delta.type === 'text_delta' && delta.text) {
      return [{ type: 'text-delta', kind: 'text', text: delta.text, parentToolCallId }];
    }
    if (delta.type === 'thinking_delta' && delta.thinking) {
      return [{ type: 'text-delta', kind: 'thinking', text: delta.thinking, parentToolCallId }];
    }
    return [];
  }

  function mapAssistant(raw: unknown): AgentEvent[] {
    const r = parse(RawAssistantSchema, raw, 'assistant');
    if (!r.ok) return r.events;
    const d = r.data;
    const out: AgentEvent[] = [];
    const providerEventId = d.uuid ?? '';
    const parentToolCallId = d.parent_tool_use_id ?? null;

    for (const block of d.message.content) {
      if (block.type === 'text') {
        const b = RawTextBlockSchema.safeParse(block);
        if (!b.success) out.push(protocolError('assistant'));
        else
          out.push({
            type: 'assistant-block',
            kind: 'text',
            text: b.data.text,
            providerEventId,
            parentToolCallId,
          });
      } else if (block.type === 'thinking') {
        const b = RawThinkingBlockSchema.safeParse(block);
        if (!b.success) out.push(protocolError('assistant'));
        else if (b.data.thinking)
          out.push({
            type: 'assistant-block',
            kind: 'thinking',
            text: b.data.thinking,
            providerEventId,
            parentToolCallId,
          });
      } else if (block.type === 'tool_use') {
        const b = RawToolUseBlockSchema.safeParse(block);
        if (!b.success) out.push(protocolError('assistant'));
        else
          out.push({
            type: 'tool-call',
            toolCallId: b.data.id,
            name: b.data.name,
            input: limitInput(b.data.input ?? {}),
            providerEventId,
            parentToolCallId,
          });
      }
    }

    if (typeof d.error === 'string' && d.error.length > 0) {
      out.push({
        type: 'error',
        category: categoryFromErrorString(d.error),
        message: assistantErrorMessage(d.message.content, d.error),
      });
    }

    // The context size comes from the last main-loop request. Synthetic messages carry zeros.
    const usage = d.message.usage;
    if (parentToolCallId === null && usage && d.message.model !== '<synthetic>') {
      contextTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
    }
    return out;
  }

  function limitInput(input: unknown): unknown {
    const json = JSON.stringify(input);
    if (json.length <= maxInputChars) return input;
    return { truncated: true, preview: json.slice(0, maxInputChars) };
  }

  function mapUser(raw: unknown): AgentEvent[] {
    const r = parse(RawUserSchema, raw, 'user');
    if (!r.ok) return r.events;
    const d = r.data;
    if (typeof d.message.content === 'string') return [];
    const out: AgentEvent[] = [];
    const parentToolCallId = d.parent_tool_use_id ?? null;
    for (const block of d.message.content) {
      if (block.type !== 'tool_result') continue;
      const b = RawToolResultBlockSchema.safeParse(block);
      if (!b.success) {
        out.push(protocolError('user'));
        continue;
      }
      const meta = d.tool_result_meta?.find((m) => m.id === b.data.tool_use_id);
      const full = toolResultText(b.data.content);
      const truncated = full.length > maxResultChars;
      const event: ToolResultEvent = {
        type: 'tool-result',
        toolCallId: b.data.tool_use_id,
        isError: b.data.is_error === true,
        text: truncated ? full.slice(0, maxResultChars) : full,
        truncated,
        notExecuted: typeof meta?.non_execution_kind === 'string' && meta.non_execution_kind !== '',
        parentToolCallId,
      };
      const decision = meta?.permission_decision;
      if (decision && (decision.decision === 'accept' || decision.decision === 'reject')) {
        event.decision = {
          outcome: decision.decision,
          source: decisionSource(decision.source),
        };
      }
      out.push(event);
    }
    return out;
  }

  function mapRateLimit(raw: unknown): AgentEvent[] {
    const r = parse(RawRateLimitSchema, raw, 'rate_limit_event');
    if (!r.ok) return r.events;
    const info = r.data.rate_limit_info;
    const status =
      info.status === 'allowed'
        ? 'allowed'
        : info.status === 'allowed_warning'
          ? 'warning'
          : info.status === 'rejected'
            ? 'rejected'
            : undefined;
    if (status === undefined) return unknownOnce(`rate_limit_event:${info.status}`);
    return [
      {
        type: 'rate-limit',
        status,
        ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt * 1000 } : {}),
        ...(typeof info.rateLimitType === 'string' ? { limitKind: info.rateLimitType } : {}),
      },
    ];
  }

  function mapResult(raw: unknown): AgentEvent[] {
    const r = parse(RawResultSchema, raw, 'result');
    if (!r.ok) return r.events;
    const d = r.data;
    sawResult = true;

    const terminalReason = d.terminal_reason ?? undefined;
    const outcome: TurnOutcome =
      d.is_error === false
        ? 'completed'
        : terminalReason?.startsWith('aborted')
          ? 'interrupted'
          : d.subtype?.startsWith('error_max')
            ? 'limit'
            : 'error';

    const result: ResultEvent = {
      type: 'result',
      outcome,
      isError: outcome === 'error' || outcome === 'limit',
      text: resultText(d.result, d.errors),
      numTurns: d.num_turns ?? 0,
      durationMs: d.duration_ms ?? 0,
      permissionDenials: (d.permission_denials ?? []).map((p) => ({
        toolName: p.tool_name,
        toolCallId: p.tool_use_id,
      })),
    };
    if (outcome !== 'completed' && outcome !== 'interrupted') {
      result.category =
        categoryFromApiStatus(d.api_error_status) ??
        (sawInit ? 'unknown' : options.resuming ? 'session-not-found' : 'startup');
    }
    if (terminalReason !== undefined) result.terminalReason = terminalReason;

    const usage = buildUsage(d);
    if (usage) result.usage = usage;
    return [result];
  }

  function buildUsage(d: z.infer<typeof RawResultSchema>): UsageInfo | undefined {
    if (!d.usage && typeof d.total_cost_usd !== 'number') return undefined;
    const usage: UsageInfo = {
      inputTokens: d.usage?.input_tokens ?? 0,
      outputTokens: d.usage?.output_tokens ?? 0,
      cacheReadTokens: d.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: d.usage?.cache_creation_input_tokens ?? 0,
    };
    if (typeof d.total_cost_usd === 'number') usage.costUsd = d.total_cost_usd;
    const contextWindow = pickContextWindow(d.modelUsage ?? undefined, initModel);
    if (contextWindow !== undefined) usage.contextWindow = contextWindow;
    if (contextTokens !== undefined) usage.contextTokens = contextTokens;
    return usage;
  }

  return {
    push(line) {
      try {
        if (line.trim() === '') return [];
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return [
            {
              type: 'error',
              category: 'protocol',
              message: 'Claude Code sent a line that is not valid JSON.',
            },
          ];
        }
        const base = RawBaseSchema.safeParse(value);
        if (!base.success) {
          return [
            {
              type: 'error',
              category: 'protocol',
              message: 'Claude Code sent a line that is not an event.',
            },
          ];
        }
        const type = base.data.type;
        switch (type) {
          case 'system': {
            const subtype = base.data['subtype'];
            return mapSystem(typeof subtype === 'string' ? subtype : undefined, value);
          }
          case 'stream_event':
            return mapStreamEvent(value);
          case 'assistant':
            return mapAssistant(value);
          case 'user':
            return mapUser(value);
          case 'rate_limit_event':
            return mapRateLimit(value);
          case 'result':
            return mapResult(value);
          default:
            return unknownOnce(type);
        }
      } catch {
        return [
          {
            type: 'error',
            category: 'protocol',
            message: 'Claude Code output could not be processed.',
          },
        ];
      }
    },

    finish(exit) {
      const out: AgentEvent[] = [];
      if (exit.droppedLines > 0) {
        out.push({
          type: 'error',
          category: 'protocol',
          message: `${exit.droppedLines} line${exit.droppedLines === 1 ? '' : 's'} of Claude Code output could not be read and ${exit.droppedLines === 1 ? 'was' : 'were'} dropped.`,
        });
      }
      if (sawResult) return out;

      if (exit.spawnError !== undefined) {
        out.push({
          type: 'error',
          category: 'startup',
          message: `Claude Code could not be started: ${exit.spawnError}`,
        });
        out.push(synthesisedResult('error', 'startup', exit.spawnError));
      } else if (exit.cancelled) {
        out.push(synthesisedResult('interrupted', undefined, ''));
      } else {
        const how =
          exit.signal !== null
            ? `was stopped by signal ${exit.signal}`
            : exit.exitCode !== null
              ? `exited with code ${exit.exitCode}`
              : 'ended';
        const tail = exit.stderrTail.trim();
        const message = `Claude Code ${how} before finishing the turn.${tail ? ` ${tail}` : ''}`;
        out.push({ type: 'error', category: 'process-crash', message });
        out.push(synthesisedResult('error', 'process-crash', message));
      }
      sawResult = true;
      return out;
    },
  };
}

function synthesisedResult(
  outcome: 'error' | 'interrupted',
  category: ErrorCategory | undefined,
  text: string,
): ResultEvent {
  return {
    type: 'result',
    outcome,
    isError: outcome === 'error',
    ...(category !== undefined ? { category } : {}),
    text,
    numTurns: 0,
    durationMs: 0,
    permissionDenials: [],
  };
}

function resultText(result: unknown, errors: unknown[] | null | undefined): string {
  if (typeof result === 'string') return result;
  const first = errors?.[0];
  return typeof first === 'string' ? first : '';
}

function toolResultText(
  content: string | { type: string; text?: string | undefined }[] | null | undefined,
): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return part.type === 'image' ? '[image]' : `[${part.type}]`;
    })
    .join('\n');
}

function decisionSource(source: string | undefined): 'provider' | 'host' | 'unknown' {
  if (source === 'config') return 'provider';
  if (source !== undefined && source.startsWith('user')) return 'host';
  return 'unknown';
}

function assistantErrorMessage(
  content: { type: string; text?: unknown }[],
  fallback: string,
): string {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return block.text;
    }
  }
  return fallback;
}

function pickContextWindow(
  modelUsage: Record<string, { contextWindow?: number | undefined }> | undefined,
  model: string | undefined,
): number | undefined {
  if (!modelUsage) return undefined;
  if (model !== undefined) {
    const own = modelUsage[model]?.contextWindow;
    if (typeof own === 'number') return own;
  }
  let best: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = entry.contextWindow;
    if (typeof w === 'number' && (best === undefined || w > best)) best = w;
  }
  return best;
}
