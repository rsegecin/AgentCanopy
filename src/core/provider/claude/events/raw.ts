import { z } from 'zod';

/**
 * Raw Claude Code stream-json lines, validated loosely: unknown extra keys are always accepted,
 * and only the fields the mapper reads are described. Almost everything is optional so that a
 * newer CLI that drops a field degrades the event instead of losing it.
 */

export const RawBaseSchema = z.looseObject({ type: z.string() });

const parentToolUseId = z.string().nullish();

export const RawInitSchema = z.looseObject({
  session_id: z.string(),
  model: z.string().optional(),
  claude_code_version: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z
    .array(z.looseObject({ name: z.string(), status: z.string().optional() }))
    .optional(),
  plugins: z.array(z.looseObject({ name: z.string(), path: z.string().optional() })).optional(),
  permissionMode: z.string().optional(),
  cwd: z.string().optional(),
  apiKeySource: z.string().optional(),
});
export type RawInit = z.infer<typeof RawInitSchema>;

export const RawSessionStateSchema = z.looseObject({ state: z.string() });

export const RawStatusSchema = z.looseObject({ status: z.string().nullish() });

export const RawApiRetrySchema = z.looseObject({
  attempt: z.number().optional(),
  max_retries: z.number().optional(),
  retry_delay_ms: z.number().optional(),
  error: z.string().nullish(),
});

export const RawHookSchema = z.looseObject({
  hook_name: z.string().optional(),
  hook_event: z.string().optional(),
  outcome: z.string().nullish(),
});

export const RawStreamEventSchema = z.looseObject({
  event: z.looseObject({ type: z.string(), delta: z.unknown().optional() }),
  parent_tool_use_id: parentToolUseId,
});

/** The delta of a content_block_delta. Other stream events carry deltas of other shapes. */
export const RawContentDeltaSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
});

const RawUsageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

export const RawContentBlockSchema = z.looseObject({ type: z.string() });
export const RawTextBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() });
export const RawThinkingBlockSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string().optional(),
});
export const RawToolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
});

export const RawAssistantSchema = z.looseObject({
  uuid: z.string().optional(),
  parent_tool_use_id: parentToolUseId,
  error: z.string().nullish(),
  message: z.looseObject({
    model: z.string().optional(),
    content: z.array(RawContentBlockSchema),
    usage: RawUsageSchema.nullish(),
  }),
});

export const RawToolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z
    .union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))])
    .nullish(),
  is_error: z.boolean().nullish(),
});

export const RawUserSchema = z.looseObject({
  parent_tool_use_id: parentToolUseId,
  message: z.looseObject({
    content: z.union([z.string(), z.array(RawContentBlockSchema)]),
  }),
  tool_result_meta: z
    .array(
      z.looseObject({
        id: z.string(),
        permission_decision: z
          .looseObject({ decision: z.string().optional(), source: z.string().optional() })
          .nullish(),
        non_execution_kind: z.string().nullish(),
      }),
    )
    .nullish(),
});

export const RawRateLimitSchema = z.looseObject({
  rate_limit_info: z.looseObject({
    status: z.string(),
    resetsAt: z.number().nullish(),
    rateLimitType: z.string().nullish(),
  }),
});

export const RawResultSchema = z.looseObject({
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: RawUsageSchema.nullish(),
  modelUsage: z
    .record(z.string(), z.looseObject({ contextWindow: z.number().optional() }))
    .nullish(),
  total_cost_usd: z.number().nullish(),
  permission_denials: z
    .array(z.looseObject({ tool_name: z.string(), tool_use_id: z.string() }))
    .nullish(),
  terminal_reason: z.string().nullish(),
  api_error_status: z.number().nullish(),
  errors: z.array(z.unknown()).nullish(),
});
