import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const failure = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

export function validateServiceIdentity(id, version) {
  for (const [name, value] of Object.entries({ id, version })) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value) || value.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
      throw failure(`Invalid capability ${name}`);
    }
  }
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw failure('Request exceeds the size limit', 413, 'REQUEST_TOO_LARGE');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw failure('Request exceeds the size limit', 413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw failure('Request must contain valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Request must be a JSON object');
  return value;
}

/** One immutable capability version. Call context is accepted only from its authenticated gateway. */
export async function startCapabilityService(options) {
  const { id, version, stateVersion = '1', token, tools = [], callTool, operations = {}, host = '127.0.0.1', port = 0,
    maxRequestBytes = 1024 * 1024 } = options;
  validateServiceIdentity(id, version);
  if (!['127.0.0.1', '::1'].includes(host)) throw failure('Capability services must listen on loopback');
  if (typeof token !== 'string' || token.length < 16) throw failure('A private capability service token is required');
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 256 || maxRequestBytes > 32 * 1024 * 1024) throw failure('Invalid request size limit');
  if (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name || !tool.inputSchema)) throw failure('Invalid capability tools');
  const names = new Set(tools.map(tool => tool.name));
  if (names.size !== tools.length) throw failure('Duplicate capability tool name');
  const manifest = JSON.parse(JSON.stringify({ id, version, stateVersion, tools }));
  const expectedToken = Buffer.from(`Bearer ${token}`);
  const active = new Set();
  let draining = false, closing = false, closed = false, drainPromise, closePromise, server;
  const authorized = req => { const actual = Buffer.from(req.headers.authorization || ''); return actual.length === expectedToken.length && timingSafeEqual(actual, expectedToken); };
  const pendingWork = async () => {
    const count = await options.pendingWork?.() ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw failure('Capability reported invalid pending work', 503, 'INVALID_PENDING_WORK');
    return count;
  };
  const health = async () => ({ id, version, stateVersion, state: closed ? 'stopped' : closing ? 'stopping' : draining ? 'draining' : 'ready',
    activeRequests: active.size, pendingWork: await pendingWork(), pid: process.pid });
  async function drain() {
    draining = true;
    if (!drainPromise) drainPromise = Promise.resolve().then(() => options.drain?.());
    await drainPromise;
    return health();
  }
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await drain();
      closing = true;
      // Background jobs retain their process and state until they finish. No timeout kills them.
      while (active.size || await pendingWork()) {
        if (active.size) await Promise.race([...active].map(item => item.done));
        else await sleep(25);
      }
      await options.close?.();
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); });
      closed = true;
      await options.onClosed?.();
    })();
    return closePromise;
  }
  async function work(req, res, action) {
    if (draining || closing) throw failure('Capability version is draining; existing bindings must switch before new work', 409, 'CAPABILITY_DRAINING');
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(failure('Caller disconnected', 499, 'CALLER_DISCONNECTED')); };
    req.once('aborted', abort); res.once('close', abort);
    let finish;
    const entry = { done: new Promise(resolve => { finish = resolve; }) };
    active.add(entry);
    try { return await action(controller.signal); }
    finally { active.delete(entry); finish(); req.removeListener('aborted', abort); res.removeListener('close', abort); }
  }
  const invokeTool = async (name, args, context, signal) => {
    if (!names.has(name)) throw failure('Unknown capability tool', 404, 'TOOL_NOT_FOUND');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('Tool arguments must be an object');
    if (typeof callTool !== 'function') throw failure('Capability has no tool handler', 503, 'HANDLER_UNAVAILABLE');
    return callTool(name, args, context ?? {}, signal);
  };
  server = createServer(async (req, res) => {
    try {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, await health());
      if (req.method === 'GET' && path === '/manifest') return json(res, 200, manifest);
      if (req.method === 'POST' && path === '/internal/drain') return json(res, 200, await drain());
      if (req.method === 'POST' && path === '/internal/shutdown') {
        // Keep accepting existing bindings when a premature shutdown is refused.
        const count = await pendingWork();
        if (active.size || count) throw failure('Capability still owns requests or background jobs', 409, 'CAPABILITY_BUSY');
        draining = true;
        json(res, 202, { accepted: true, id, version });
        setImmediate(() => close().catch(error => options.onError?.(error)));
        return;
      }
      if (req.method === 'POST' && path.startsWith('/tools/')) {
        const result = await work(req, res, async signal => {
          const body = await readBody(req, maxRequestBytes);
          return invokeTool(decodeURIComponent(path.slice(7)), body.arguments ?? {}, body.context, signal);
        });
        return json(res, 200, result ?? null);
      }
      if (req.method === 'POST' && path.startsWith('/rpc/')) {
        const result = await work(req, res, async signal => {
          const name = decodeURIComponent(path.slice(5));
          if (!Object.hasOwn(operations, name) || typeof operations[name] !== 'function') throw failure('Unknown capability operation', 404, 'OPERATION_NOT_FOUND');
          const body = await readBody(req, maxRequestBytes);
          if (!Array.isArray(body.arguments ?? [])) throw failure('Operation arguments must be an array');
          // Internal RPC preserves the domain method's positional/default arguments.
          // Tool calls carry actor context and cancellation through callTool instead.
          return operations[name](...(body.arguments ?? []));
        });
        return json(res, 200, result ?? null);
      }
      if (req.method === 'POST' && path === '/mcp') {
        const body = await readBody(req, maxRequestBytes);
        const requestId = body.id;
        const reply = result => json(res, 200, { jsonrpc: '2.0', id: requestId, result });
        if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return json(res, 400, { jsonrpc: '2.0', id: requestId ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
        if (requestId === undefined) { res.writeHead(202); res.end(); return; }
        if (body.method === 'initialize') return reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(body.params?.protocolVersion) ? body.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: id, version } });
        if (body.method === 'ping') return reply({});
        if (body.method === 'tools/list') return reply({ tools: manifest.tools.map(({ effect, ...tool }) => tool) });
        if (body.method === 'tools/call') {
          try {
            const result = await work(req, res, signal => invokeTool(body.params?.name, body.params?.arguments ?? {}, body.params?._meta?.context, signal));
            return reply(result?.content && Array.isArray(result.content) ? result : { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] });
          } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code || 'CAPABILITY_ERROR' }) }] }); }
        }
        return json(res, 200, { jsonrpc: '2.0', id: requestId, error: { code: -32601, message: 'Method not found' } });
      }
      json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    } catch (error) {
      json(res, Number.isInteger(error.status) ? error.status : 500, { error: error.message || 'Capability request failed', code: error.code || 'CAPABILITY_ERROR' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
  return { url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`, manifest, server, health, drain, close };
}
