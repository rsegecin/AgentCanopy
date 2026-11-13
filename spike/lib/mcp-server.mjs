// Minimal MCP Streamable HTTP server for the W1 spike. Node built-ins only.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const PERMISSION_DESC =
  'Internal. Called by the Claude Code runtime to request approval. Not for the assistant to call.';

export const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});
export const allow = (updatedInput) =>
  textResult(JSON.stringify(updatedInput === undefined ? { behavior: 'allow' } : { behavior: 'allow', updatedInput }));
export const deny = (message) => textResult(JSON.stringify({ behavior: 'deny', message }));

function tools(submitPlan) {
  const list = [
    {
      name: 'permission_prompt',
      description: PERMISSION_DESC,
      inputSchema: { type: 'object', additionalProperties: true },
    },
  ];
  if (submitPlan) {
    list.push({
      name: 'submit_plan',
      description: 'Submit a plan consisting of a title and ordered stages.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' } },
              required: ['id', 'title'],
            },
          },
          notes: { type: 'string' },
        },
        required: ['title', 'stages'],
      },
    });
  }
  return list;
}

/**
 * handler(call) -> Promise<{result?, delayMs?, sse?: {everyMs}, never?: boolean}> | same
 * call = { name, args, meta, rpcId, seq, reqHeaders }
 */
export async function startServer({ dir, prefix = '', handler, submitPlan = false }) {
  const token = crypto.randomBytes(24).toString('hex');
  const mcpRand = crypto.randomBytes(12).toString('hex');
  const hookRand = crypto.randomBytes(12).toString('hex');
  const mcpLog = path.join(dir, `${prefix}mcp.jsonl`);
  const hookLog = path.join(dir, `${prefix}hook.jsonl`);
  fs.writeFileSync(mcpLog, '');
  fs.writeFileSync(hookLog, '');
  const events = new EventEmitter();
  const sockets = new Set();
  let seq = 0;
  const log = (obj) => fs.appendFileSync(mcpLog, JSON.stringify({ t: new Date().toISOString(), ms: Date.now(), ...obj }) + '\n');

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  const server = http.createServer(async (req, res) => {
    const reqId = ++seq;
    const headers = { ...req.headers };
    const auth = headers.authorization;
    if (auth !== undefined) headers.authorization = '[redacted]';
    const raw = await readBody(req);
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = { __unparsed: raw.slice(0, 500) }; }
    const base = { reqId, method: req.method, url: req.url, headers, body };
    const sockId = `${req.socket.remotePort}`;
    res.on('close', () => log({ event: 'response-close', reqId, sock: sockId, writableFinished: res.writableFinished, ended: res.writableEnded }));
    req.socket.once('close', () => log({ event: 'socket-close', reqId, sock: sockId }));

    // hook endpoint (no auth required: hook config has no headers)
    if (req.method === 'POST' && req.url === `/hook/${hookRand}`) {
      log({ ...base, kind: 'hook' });
      fs.appendFileSync(hookLog, JSON.stringify({ t: new Date().toISOString(), headers, body }) + '\n');
      events.emit('hook', body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url !== `/mcp/${mcpRand}`) {
      log({ ...base, kind: 'unknown-route' });
      res.writeHead(404); res.end(); return;
    }
    if (auth !== `Bearer ${token}`) {
      log({ ...base, kind: 'unauthorized' });
      res.writeHead(401); res.end(); return;
    }
    log({ ...base, kind: 'mcp' });
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }); res.end(); return;
    }
    const msgs = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      const hasId = m.id !== undefined && m.id !== null;
      if (!hasId) { events.emit('notification', m); continue; }
      switch (m.method) {
        case 'initialize':
          replies.push({ jsonrpc: '2.0', id: m.id, result: {
            protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'agentcanopy-spike', version: '0.0.1' },
          } });
          break;
        case 'ping': replies.push({ jsonrpc: '2.0', id: m.id, result: {} }); break;
        case 'tools/list': replies.push({ jsonrpc: '2.0', id: m.id, result: { tools: tools(submitPlan) } }); break;
        case 'tools/call': {
          // tools/call handled asynchronously; only single-message POSTs expected
          await handleCall(m, req, res, headers);
          return;
        }
        default:
          replies.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      }
    }
    if (!replies.length) { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replies.length === 1 && !Array.isArray(body) ? replies[0] : replies));
  });

  async function handleCall(m, req, res, headers) {
    const call = { name: m.params?.name, args: m.params?.arguments, meta: m.params?._meta, rpcId: m.id, reqHeaders: headers };
    events.emit('call', call);
    let out;
    try {
      out = await handler(call);
    } catch (e) {
      out = { result: textResult(`handler error: ${e.message}`, true) };
    }
    out = out ?? {};
    if (out.never) {
      log({ event: 'call-left-unanswered', rpcId: m.id, name: call.name });
      return; // never answer; socket stays open
    }
    const result = out.result ?? textResult('ok');
    const final = { jsonrpc: '2.0', id: m.id, result };
    const progressToken = call.meta?.progressToken;
    if (out.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': stream-open\n\n');
      const every = out.sse.everyMs ?? 25000;
      let n = 0;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) { clearInterval(timer); return; }
        n++;
        if (progressToken !== undefined) {
          const note = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n, message: `tick ${n}` } };
          res.write(`data: ${JSON.stringify(note)}\n\n`);
          log({ event: 'sse-progress-sent', rpcId: m.id, n });
        } else {
          res.write(`: keepalive ${n}\n\n`);
          log({ event: 'sse-comment-sent', rpcId: m.id, n, note: 'no progressToken supplied' });
        }
      }, every);
      await new Promise((r) => setTimeout(r, out.delayMs ?? 0));
      clearInterval(timer);
      if (res.writableEnded || res.destroyed) { log({ event: 'sse-aborted-before-final', rpcId: m.id }); return; }
      res.write(`data: ${JSON.stringify(final)}\n\n`);
      res.end();
      log({ event: 'call-answered', mode: 'sse', rpcId: m.id, name: call.name, result });
      return;
    }
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    if (res.writableEnded || res.destroyed) { log({ event: 'answer-dropped-socket-closed', rpcId: m.id, name: call.name }); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(final));
    log({ event: 'call-answered', mode: 'json', rpcId: m.id, name: call.name, result });
  }

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mcpUrl = `http://127.0.0.1:${port}/mcp/${mcpRand}`;
  const hookUrl = `http://127.0.0.1:${port}/hook/${hookRand}`;
  const configFile = path.join(dir, `${prefix}mcp-config.json`);
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mcpServers: { agentcanopy: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` }, timeout: 600000 } } }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(configFile, 0o600);
  return {
    port, mcpUrl, hookUrl, configFile, events,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
