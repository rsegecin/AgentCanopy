import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HOST_SERVER_NAME,
  PERMISSION_TOOL,
  PLAN_TOOL,
  silentLogger,
  type HostEndpoint,
  type HostToolServer,
  type Logger,
  type PermissionResponse,
  type TurnHostHandlers,
  type TurnRegistration,
} from '../contracts';
import { newSecret, secretsEqual, sha256Hex } from '../util';
import {
  DEFAULT_PROTOCOL_VERSION,
  OWN_TOOL_PREFIX,
  PERMISSION_TOOL_DESCRIPTION,
  PERMISSION_TOOL_INPUT_SCHEMA,
  PLAN_TOOL_DESCRIPTION,
  RPC_ERROR,
  SERVER_VERSION,
  hookBodySchema,
  isProgressToken,
  isRecord,
  permissionArgumentsSchema,
  rpcError,
  rpcResult,
  sseMessage,
  textResult,
  type JsonRpcId,
} from './protocol';

export interface HostToolServerOptions {
  logger?: Logger;
  /** Interval of progress messages on a pending permission request. Default 25 s. */
  heartbeatMs?: number;
  /** Largest accepted request body. Default 16 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const KEEP_ALIVE_TIMEOUT_MS = 120_000;
const BODY_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;
const MAX_LOGGED_NAME = 100;

const DENY_FAILED: PermissionResponse = {
  behavior: 'deny',
  message: 'AgentCanopy could not process this permission request.',
};

/** One pending permission request per tool call id. Several HTTP requests may wait on it. */
interface Entry {
  toolCallId: string;
  /** Hash of tool name and canonical input: only an identical request may join this entry. */
  fingerprint: string;
  controller: AbortController;
  waiters: Set<Waiter>;
  settled: boolean;
}

/** One HTTP request waiting for a permission answer. */
interface Waiter {
  rpcId: JsonRpcId;
  res: ServerResponse;
  sse: boolean;
  entry: Entry;
  timer: NodeJS.Timeout | undefined;
  done: boolean;
}

interface Route {
  routeId: string;
  token: string;
  hookSecret: string | undefined;
  handlers: TurnHostHandlers;
  planSchema: Record<string, unknown> | undefined;
  disposed: boolean;
  entries: Map<string, Entry>;
  waiters: Set<Waiter>;
  waitersByRpcId: Map<string | number, Waiter>;
}

interface RequestLog {
  kind: 'mcp' | 'hook' | 'other';
  rpcMethod?: string;
  tool?: string;
}

interface RpcRequest {
  /** undefined: the message carries no id, so it is a notification. */
  id: JsonRpcId | undefined;
  method: string;
  params: unknown;
}

type BodyResult =
  { ok: true; body: Buffer } | { ok: false; reason: 'too-large' | 'timeout' | 'aborted' };

function noop(): void {
  /* swallow late socket errors */
}

function truncate(value: string): string {
  return value.length > MAX_LOGGED_NAME ? `${value.slice(0, MAX_LOGGED_NAME)}...` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canWrite(res: ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || !canWrite(res)) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/** An HTTP-level failure. The body is fixed text and never reflects the request. */
function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}) {
  sendJson(res, status, { error: STATUS_CODES[status] ?? 'Error' }, headers);
}

function sendEmpty(res: ServerResponse, status: number): void {
  if (res.headersSent || !canWrite(res)) return;
  res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), BODY_TIMEOUT_MS);
    req.on('data', onData);
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on('close', () => finish({ ok: false, reason: 'aborted' }));
    req.on('error', () => finish({ ok: false, reason: 'aborted' }));
  });
}

function withTimeout(work: Promise<void>, ms: number): Promise<'done' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve('done');
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function normalizePermission(value: unknown): PermissionResponse {
  if (isRecord(value) && value.behavior === 'allow') {
    return isRecord(value.updatedInput)
      ? { behavior: 'allow', updatedInput: value.updatedInput }
      : { behavior: 'allow' };
  }
  if (isRecord(value) && value.behavior === 'deny' && typeof value.message === 'string') {
    return { behavior: 'deny', message: value.message };
  }
  return DENY_FAILED;
}

/** JSON with object keys sorted recursively, so equal inputs give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function permissionFingerprint(toolName: string, input: Record<string, unknown>): string {
  return sha256Hex(`${JSON.stringify(toolName)}\n${canonicalJson(input)}`);
}

function permissionResult(response: PermissionResponse): Record<string, unknown> {
  return textResult(JSON.stringify(response));
}

function deny(message: string): Record<string, unknown> {
  return permissionResult({ behavior: 'deny', message });
}

function parseRpcRequest(value: Record<string, unknown>): RpcRequest | 'invalid' {
  if (typeof value.method !== 'string') return 'invalid';
  const rawId = value.id;
  if (
    rawId !== undefined &&
    rawId !== null &&
    typeof rawId !== 'string' &&
    typeof rawId !== 'number'
  )
    return 'invalid';
  return { id: rawId, method: value.method, params: value.params };
}

export function createHostToolServer(options: HostToolServerOptions = {}): HostToolServer {
  const logger = options.logger ?? silentLogger;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const routes = new Map<string, Route>();
  let server: Server | undefined;
  let starting: Promise<void> | undefined;
  let port = 0;

  // ---- permission requests ----

  /** Ends a waiter's HTTP response with one JSON-RPC message, in its transport. */
  function emit(waiter: Waiter, message: unknown): void {
    const { res } = waiter;
    if (!canWrite(res)) return;
    if (waiter.sse) {
      res.write(sseMessage(message));
      res.end();
    } else {
      sendJson(res, 200, message);
    }
  }

  function release(route: Route, waiter: Waiter): void {
    waiter.done = true;
    if (waiter.timer) clearInterval(waiter.timer);
    waiter.timer = undefined;
    route.waiters.delete(waiter);
    if (typeof waiter.rpcId !== 'object' && route.waitersByRpcId.get(waiter.rpcId) === waiter) {
      route.waitersByRpcId.delete(waiter.rpcId);
    }
    waiter.entry.waiters.delete(waiter);
  }

  /** The request goes away without an answer. The handler is aborted when nobody waits any more. */
  function detach(route: Route, waiter: Waiter, how: 'disconnect' | 'cancel'): void {
    if (waiter.done) return;
    const { entry } = waiter;
    release(route, waiter);
    if (how === 'cancel') {
      emit(waiter, rpcError(waiter.rpcId, RPC_ERROR.cancelled, 'Request cancelled'));
    }
    if (entry.waiters.size === 0 && !entry.settled) {
      if (route.entries.get(entry.toolCallId) === entry) route.entries.delete(entry.toolCallId);
      entry.controller.abort();
    }
  }

  function settle(route: Route, entry: Entry, response: PermissionResponse): void {
    if (entry.controller.signal.aborted) return;
    entry.settled = true;
    if (route.entries.get(entry.toolCallId) === entry) route.entries.delete(entry.toolCallId);
    for (const waiter of [...entry.waiters]) {
      release(route, waiter);
      emit(waiter, rpcResult(waiter.rpcId, permissionResult(response)));
    }
  }

  function startEntry(
    route: Route,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    fingerprint: string,
  ): Entry {
    const controller = new AbortController();
    const entry: Entry = {
      toolCallId,
      fingerprint,
      controller,
      waiters: new Set(),
      settled: false,
    };
    route.entries.set(toolCallId, entry);
    const call = (async () =>
      route.handlers.onPermissionRequest({
        toolCallId,
        toolName,
        input,
        signal: controller.signal,
      }))();
    void call
      .then(normalizePermission, (error: unknown) => {
        logger.error('Permission handler failed', {
          tool: truncate(toolName),
          error: errorMessage(error),
        });
        return DENY_FAILED;
      })
      .then((response) => settle(route, entry, response));
    return entry;
  }

  function handlePermission(
    route: Route,
    rpcId: JsonRpcId,
    params: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
    log: RequestLog,
  ): void {
    const parsed = permissionArgumentsSchema.safeParse(params.arguments);
    if (!parsed.success) {
      sendJson(res, 200, rpcResult(rpcId, deny('Permission request was malformed.')));
      return;
    }
    const { tool_name: toolName, input, tool_use_id: argId } = parsed.data;
    log.tool = truncate(toolName);
    const meta = isRecord(params._meta) ? params._meta : {};
    const metaId = meta['claudecode/toolUseId'];
    const toolCallId =
      typeof argId === 'string' && argId.length > 0
        ? argId
        : typeof metaId === 'string' && metaId.length > 0
          ? metaId
          : undefined;
    if (toolCallId === undefined) {
      sendJson(res, 200, rpcResult(rpcId, deny('Permission request had no tool call id.')));
      return;
    }
    if (toolName.startsWith(OWN_TOOL_PREFIX)) {
      sendJson(
        res,
        200,
        rpcResult(rpcId, deny('This tool cannot be approved through a permission request.')),
      );
      return;
    }

    const progressToken = meta.progressToken;
    const accept = req.headers.accept ?? '';
    const sse = accept.includes('text/event-stream') && isProgressToken(progressToken);

    const fingerprint = permissionFingerprint(toolName, input);
    const pendingEntry = route.entries.get(toolCallId);
    if (pendingEntry && pendingEntry.fingerprint !== fingerprint) {
      logger.warn('Permission request does not match the pending one', {
        tool: truncate(toolName),
      });
      sendJson(
        res,
        200,
        rpcResult(
          rpcId,
          deny(
            'This permission request does not match the one already pending for the same tool call.',
          ),
        ),
      );
      return;
    }
    const entry = pendingEntry ?? startEntry(route, toolCallId, toolName, input, fingerprint);
    const waiter: Waiter = { rpcId, res, sse, entry, timer: undefined, done: false };
    entry.waiters.add(waiter);
    route.waiters.add(waiter);
    if (typeof rpcId !== 'object') route.waitersByRpcId.set(rpcId, waiter);

    if (sse && isProgressToken(progressToken)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      let counter = 0;
      waiter.timer = setInterval(() => {
        if (waiter.done || !canWrite(res)) return;
        counter += 1;
        res.write(
          sseMessage({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: counter },
          }),
        );
      }, heartbeatMs);
    }
    res.on('close', () => detach(route, waiter, 'disconnect'));
  }

  // ---- JSON-RPC dispatch ----

  async function handlePlan(
    route: Route,
    rpcId: JsonRpcId,
    params: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    let result: Record<string, unknown>;
    try {
      if (!route.handlers.onPlanSubmitted) throw new Error('No plan handler');
      const outcome = await route.handlers.onPlanSubmitted(params.arguments ?? {});
      result = textResult(String(outcome.text), outcome.isError === true);
    } catch (error) {
      logger.error('Plan handler failed', { error: errorMessage(error) });
      result = textResult('The plan could not be saved.', true);
    }
    sendJson(res, 200, rpcResult(rpcId, result));
  }

  async function dispatch(
    route: Route,
    rpc: RpcRequest,
    req: IncomingMessage,
    res: ServerResponse,
    log: RequestLog,
  ): Promise<void> {
    log.rpcMethod = truncate(rpc.method);
    if (rpc.method.startsWith('notifications/') || rpc.id === undefined) {
      if (rpc.method === 'notifications/cancelled' && isRecord(rpc.params)) {
        const requestId = rpc.params.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          const waiter = route.waitersByRpcId.get(requestId);
          if (waiter) detach(route, waiter, 'cancel');
        }
      }
      sendEmpty(res, 202);
      return;
    }
    const id = rpc.id;
    const params = isRecord(rpc.params) ? rpc.params : {};
    switch (rpc.method) {
      case 'initialize': {
        const version = params.protocolVersion;
        sendJson(
          res,
          200,
          rpcResult(id, {
            protocolVersion: typeof version === 'string' ? version : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: HOST_SERVER_NAME, version: SERVER_VERSION },
          }),
        );
        return;
      }
      case 'ping':
        sendJson(res, 200, rpcResult(id, {}));
        return;
      case 'tools/list': {
        const tools: unknown[] = [
          {
            name: PERMISSION_TOOL,
            description: PERMISSION_TOOL_DESCRIPTION,
            inputSchema: PERMISSION_TOOL_INPUT_SCHEMA,
          },
        ];
        if (route.planSchema) {
          tools.push({
            name: PLAN_TOOL,
            description: PLAN_TOOL_DESCRIPTION,
            inputSchema: route.planSchema,
          });
        }
        sendJson(res, 200, rpcResult(id, { tools }));
        return;
      }
      case 'tools/call': {
        const name = params.name;
        if (name === PERMISSION_TOOL) {
          handlePermission(route, id, params, req, res, log);
          return;
        }
        if (name === PLAN_TOOL && route.planSchema) {
          log.tool = PLAN_TOOL;
          await handlePlan(route, id, params, res);
          return;
        }
        sendJson(res, 200, rpcError(id, RPC_ERROR.invalidParams, 'Unknown tool'));
        return;
      }
      default:
        sendJson(res, 200, rpcError(id, RPC_ERROR.methodNotFound, 'Method not found'));
    }
  }

  async function handleMcp(
    route: Route,
    req: IncomingMessage,
    res: ServerResponse,
    log: RequestLog,
  ): Promise<void> {
    const authorization = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(authorization);
    if (!match?.[1] || !secretsEqual(match[1], route.token)) {
      sendStatus(res, 401, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    await checkContentTypeAndReadBody(req, res, async (raw) => {
      if (route.disposed) {
        sendStatus(res, 404);
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, rpcError(null, RPC_ERROR.parse, 'Parse error'));
        return;
      }
      if (Array.isArray(json)) {
        sendJson(
          res,
          400,
          rpcError(null, RPC_ERROR.invalidRequest, 'Batch requests are not supported'),
        );
        return;
      }
      if (!isRecord(json)) {
        sendJson(res, 400, rpcError(null, RPC_ERROR.parse, 'Parse error'));
        return;
      }
      const rpc = parseRpcRequest(json);
      if (rpc === 'invalid') {
        const id = typeof json.id === 'string' || typeof json.id === 'number' ? json.id : null;
        sendJson(res, 400, rpcError(id, RPC_ERROR.invalidRequest, 'Invalid request'));
        return;
      }
      await dispatch(route, rpc, req, res, log);
    });
  }

  // ---- hooks ----

  async function handleHook(
    route: Route,
    phase: 'pre' | 'post',
    failed: boolean,
    raw: Buffer,
    res: ServerResponse,
    log: RequestLog,
  ): Promise<void> {
    log.rpcMethod = phase;
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      logger.warn('Hook body was not JSON', { phase });
      sendJson(res, 200, {});
      return;
    }
    const parsed = hookBodySchema.safeParse(body);
    if (!parsed.success) {
      logger.warn('Hook body was malformed', { phase });
      sendJson(res, 200, {});
      return;
    }
    log.tool = truncate(parsed.data.tool_name);
    if (route.handlers.onToolHook) {
      try {
        const outcome = await withTimeout(
          (async () =>
            route.handlers.onToolHook?.({
              phase,
              toolCallId: parsed.data.tool_use_id,
              toolName: parsed.data.tool_name,
              input: parsed.data.tool_input,
              ...(failed ? { failed: true } : {}),
            }))(),
          HOOK_TIMEOUT_MS,
        );
        if (outcome === 'timeout') logger.warn('Tool hook handler timed out', { phase });
      } catch (error) {
        logger.error('Tool hook handler failed', { phase, error: errorMessage(error) });
      }
    }
    sendJson(res, 200, {});
  }

  // ---- shared request checks ----

  /**
   * Checks the content type, reads the body within the cap and the time limit, then runs `next`.
   * Returns false when it already answered.
   */
  async function checkContentTypeAndReadBody(
    req: IncomingMessage,
    res: ServerResponse,
    next: (raw: Buffer) => Promise<void>,
  ): Promise<boolean> {
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendStatus(res, 415);
      return false;
    }
    const declared = Number(req.headers['content-length']);
    const rejectLarge = (): void => {
      sendStatus(res, 413, { Connection: 'close' });
      res.once('finish', () => req.socket.destroy());
    };
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      rejectLarge();
      return false;
    }
    const result = await readBody(req, maxBodyBytes);
    if (!result.ok) {
      if (result.reason === 'too-large') {
        rejectLarge();
      } else if (result.reason === 'timeout') {
        sendStatus(res, 408, { Connection: 'close' });
        res.once('finish', () => req.socket.destroy());
      }
      return false;
    }
    await next(result.body);
    return true;
  }

  function findHookRoute(secret: string): Route | undefined {
    let found: Route | undefined;
    for (const route of routes.values()) {
      if (route.hookSecret !== undefined && secretsEqual(secret, route.hookSecret)) found = route;
    }
    return found;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const log: RequestLog = { kind: 'other' };
    res.on('error', noop);
    req.on('error', noop);
    res.on('close', () => {
      logger.debug('Host request', {
        kind: log.kind,
        rpcMethod: log.rpcMethod,
        tool: log.tool,
        status: res.statusCode,
        completed: res.writableFinished,
      });
    });

    const parts = (req.url ?? '').split('?')[0]?.split('/') ?? [];
    const area = parts[1];
    const isMcp = area === 'mcp' && parts.length === 3;
    const isHook =
      area === 'hook' &&
      parts.length === 4 &&
      (parts[3] === 'pre' || parts[3] === 'post' || parts[3] === 'post-failure');
    log.kind = isMcp ? 'mcp' : isHook ? 'hook' : 'other';

    if ((area === 'mcp' || area === 'hook') && req.method !== 'POST') {
      sendStatus(res, 405, { Allow: 'POST' });
      return;
    }
    if (req.headers.host !== `127.0.0.1:${port}`) {
      sendStatus(res, 403);
      return;
    }
    if (req.headers.origin !== undefined) {
      sendStatus(res, 403);
      return;
    }

    if (isMcp) {
      const route = routes.get(parts[2] ?? '');
      if (!route || route.disposed) {
        sendStatus(res, 404);
        return;
      }
      await handleMcp(route, req, res, log);
      return;
    }
    if (isHook) {
      const route = findHookRoute(parts[2] ?? '');
      if (!route || route.disposed) {
        sendStatus(res, 404);
        return;
      }
      const kind = parts[3];
      if (kind !== 'pre' && kind !== 'post' && kind !== 'post-failure') {
        sendStatus(res, 404);
        return;
      }
      const phase = kind === 'pre' ? 'pre' : 'post';
      await checkContentTypeAndReadBody(req, res, async (raw) => {
        if (route.disposed) {
          sendStatus(res, 404);
          return;
        }
        await handleHook(route, phase, kind === 'post-failure', raw, res, log);
      });
      return;
    }
    sendStatus(res, 404);
  }

  // ---- registrations ----

  function disposeRoute(route: Route): void {
    if (route.disposed) return;
    route.disposed = true;
    routes.delete(route.routeId);
    for (const waiter of [...route.waiters]) detach(route, waiter, 'cancel');
  }

  return {
    start(): Promise<void> {
      if (starting) return starting;
      const created = createServer((req, res) => {
        handleRequest(req, res).catch((error: unknown) => {
          logger.error('Host request failed', { error: errorMessage(error) });
          sendStatus(res, 500);
        });
      });
      created.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
      // Receiving the body is limited by readBody. A response may stay pending for hours.
      created.requestTimeout = 0;
      starting = new Promise<void>((resolve, reject) => {
        created.once('error', (error) => {
          starting = undefined;
          reject(error);
        });
        created.listen(0, '127.0.0.1', () => {
          port = (created.address() as AddressInfo).port;
          server = created;
          logger.info('Host tool server listening', { port });
          resolve();
        });
      });
      return starting;
    },

    registerTurn(handlers, registration): TurnRegistration {
      if (!server) throw new Error('The host tool server is not started.');
      const routeId = newSecret();
      const token = newSecret();
      const hookSecret = newSecret();
      const route: Route = {
        routeId,
        token,
        hookSecret: registration.toolHooks ? hookSecret : undefined,
        handlers,
        planSchema: registration.planToolInputSchema,
        disposed: false,
        entries: new Map(),
        waiters: new Set(),
        waitersByRpcId: new Map(),
      };
      routes.set(routeId, route);
      const endpoint: HostEndpoint = {
        serverName: HOST_SERVER_NAME,
        url: `http://127.0.0.1:${port}/mcp/${routeId}`,
        bearerToken: token,
        permissionToolName: PERMISSION_TOOL,
        ...(registration.planToolInputSchema ? { planToolName: PLAN_TOOL } : {}),
        ...(registration.toolHooks
          ? { hookUrl: `http://127.0.0.1:${port}/hook/${hookSecret}` }
          : {}),
      };
      return { endpoint, dispose: () => disposeRoute(route) };
    },

    async stop(): Promise<void> {
      if (starting && !server) await starting.catch(noop);
      const current = server;
      starting = undefined;
      server = undefined;
      if (!current) return;
      for (const route of [...routes.values()]) disposeRoute(route);
      port = 0;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections();
      });
      logger.info('Host tool server stopped');
    },
  };
}
