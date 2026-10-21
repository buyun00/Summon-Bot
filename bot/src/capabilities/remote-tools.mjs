import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectMcpTools } from './mcp-client.mjs';

const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const effects = new Set(['read', 'write', 'process', 'external']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function environmentValue(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new TypeError('Invalid environment reference');
  if (process.env[name] === undefined) throw new Error(`Required environment variable ${name} is not configured`);
  return process.env[name];
}

function credentials(definition, secrets) {
  for (const key of ['headers', 'headersEnv', 'env']) if (definition[key] !== undefined && !isRecord(definition[key])) throw new TypeError(`${key} must be an object`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(definition.headers || {})) {
    if (typeof value !== 'string') throw new TypeError('Configured HTTP header values must be strings');
    headers.set(key, value); if (value) secrets.add(value);
  }
  for (const [key, reference] of Object.entries(definition.headersEnv || {})) {
    const value = environmentValue(reference);
    headers.set(key, value); if (value) secrets.add(value);
  }
  const environment = {};
  for (const [key, configured] of Object.entries(definition.env || {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new TypeError('Invalid configured environment name');
    const value = isRecord(configured) ? environmentValue(configured.env) : configured;
    if (typeof value !== 'string') throw new TypeError('Configured environment values must be strings or {env: name} references');
    environment[key] = value;
    if (value && (isRecord(configured) || /token|secret|password|api.?key|credential/i.test(key))) secrets.add(value);
  }
  return { headers: Object.fromEntries(headers), environment };
}

function sanitizedError(error, redact) {
  const result = new Error(redact(error?.message || String(error)));
  result.name = error?.name || 'Error';
  for (const key of ['code', 'status', 'statusCode']) if (error?.[key] !== undefined) result[key] = typeof error[key] === 'string' ? redact(error[key]) : error[key];
  if (error?.responseBody !== undefined) result.responseBody = sanitizeValue(error.responseBody, redact);
  return result;
}

function sanitizeValue(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, redact));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    // Binary MCP blocks must retain their byte-for-byte content.
    key === 'data' && ['image', 'audio'].includes(value.type) ? item : sanitizeValue(item, redact)]));
}

function toolResult(value, redact) {
  const cleaned = sanitizeValue(value, redact);
  if (isRecord(cleaned) && Array.isArray(cleaned.content)) return cleaned;
  return { content: [{ type: 'text', text: typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned ?? null) }], details: cleaned };
}

function httpTool(definition, headers) {
  const url = new URL(definition.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('HTTP tools require an HTTP(S) URL without embedded credentials');
  if (definition.method !== undefined && definition.method !== 'POST') throw new TypeError('HTTP tools currently require method POST');
  if (definition.bodyMode !== undefined && !['arguments', 'raw'].includes(definition.bodyMode)) throw new TypeError('HTTP bodyMode must be arguments or raw');
  const requestHeaders = new Headers({ 'Content-Type': 'application/json' });
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  return { ...definition, effect: definition.effect || 'external',
    async execute(args, context) {
      const response = await fetch(url, { method: 'POST', headers: requestHeaders,
        redirect: 'error', signal: context.signal,
        body: JSON.stringify(definition.bodyMode === 'raw' ? args : { arguments: args }) });
      const text = await response.text();
      let payload = text;
      if (response.headers.get('content-type')?.toLowerCase().includes('json')) {
        try { payload = text ? JSON.parse(text) : null; }
        catch { throw Object.assign(new Error('HTTP tool returned invalid JSON'), { status: response.status }); }
      }
      if (!response.ok) {
        const detail = isRecord(payload) ? payload.error?.message || payload.error || payload.message : payload;
        throw Object.assign(new Error(`HTTP tool returned ${response.status}${detail ? `: ${String(detail).slice(0, 1200)}` : ''}`),
          { status: response.status, responseBody: payload });
      }
      return payload;
    },
  };
}

/** Explicit capability configuration only. HTTP defaults to {arguments: args};
 * bodyMode:'raw' sends args directly. headersEnv maps header names to environment
 * names; stdio env entries may use {env:'NAME'} to reference a credential.
 * Modules are trusted code selected by absolute path, never auto-discovered.
 */
export async function loadConfiguredTools(definitions = [], { botId, dataDir, workspace, signal, redact: customRedact } = {}) {
  if (!Array.isArray(definitions)) throw new TypeError('Configured capabilities must be an array');
  const secrets = new Set();
  const redact = value => {
    let text = String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
    return customRedact ? String(customRedact(text)) : text;
  };
  const lifetime = new AbortController();
  const signals = (...values) => AbortSignal.any([lifetime.signal, signal, ...values].filter(Boolean));
  const closers = [], tools = [], names = new Set();
  let closing;
  const close = () => closing ||= (async () => {
    lifetime.abort(new Error('Configured capabilities are closed'));
    await Promise.allSettled(closers.reverse().map(dispose => Promise.resolve().then(dispose)));
  })();
  try {
    signal?.throwIfAborted();
    for (const definition of definitions) {
      if (!isRecord(definition)) throw new TypeError('Capability definition must be an object');
      const timeout = definition.timeoutMs ?? 30000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new TypeError('Capability timeoutMs must be an integer from 1 to 300000');
      const resolved = credentials(definition, secrets);
      let loaded;
      if (definition.type === 'http') loaded = { tools: [httpTool(definition, resolved.headers)] };
      else if (definition.type === 'module') {
        if (typeof definition.module !== 'string' || !isAbsolute(definition.module)) throw new TypeError('Trusted tool module must use an absolute file path');
        const module = await import(pathToFileURL(definition.module).href);
        const factory = module[definition.exportName || 'createTools'];
        if (typeof factory !== 'function') throw new TypeError('Configured tool module export must be a factory');
        const result = await factory(Object.freeze({ botId, dataDir, workspace, signal: signals(), redact }), definition.options || {});
        loaded = Array.isArray(result) ? { tools: result } : result;
      } else if (definition.type === 'mcp') {
        loaded = await connectMcpTools(definition, { botId, workspace, signal: signals(), redact, ...resolved });
      } else throw new TypeError('Capability type must be http, module or mcp');
      if (loaded && typeof loaded.close === 'function') closers.push(() => loaded.close());
      signal?.throwIfAborted();
      if (!Array.isArray(loaded?.tools)) throw new TypeError('Capability factory must return tools');
      for (const tool of loaded.tools) {
        const effect = tool.effect || 'external';
        if (typeof tool?.name !== 'string' || !toolName.test(tool.name) || typeof tool.description !== 'string' || tool.inputSchema?.type !== 'object' ||
            typeof tool.execute !== 'function' || !effects.has(effect)) throw new TypeError('Invalid configured tool definition');
        if (names.has(tool.name)) throw new Error(`Configured tool name collision: ${tool.name}`);
        names.add(tool.name);
        tools.push({ name: tool.name, description: redact(tool.description), inputSchema: tool.inputSchema, effect,
          classify: typeof tool.classify === 'function' ? (result, context) => tool.classify(result, context) : result => result?.isError ? 'failed' : 'completed',
          async execute(args, context = {}) {
            const executionSignal = signals(context.signal, AbortSignal.timeout(timeout));
            try {
              executionSignal.throwIfAborted();
              const result = await tool.execute(args, { ...context, botId, dataDir, workspace, signal: executionSignal });
              executionSignal.throwIfAborted();
              return toolResult(result, redact);
            } catch (error) {
              const failure = sanitizedError(error, redact);
              // A local timeout/close cannot establish that a remote mutation
              // did not happen. Registry cancellation semantics retain unknown
              // outcomes instead of recording an ordinary retryable failure.
              if (executionSignal.aborted) {
                failure.name = 'AbortError';
                failure.code = executionSignal.reason?.name === 'TimeoutError' ? 'CAPABILITY_TIMEOUT' : 'CAPABILITY_ABORTED';
              }
              throw failure;
            }
          },
        });
      }
    }
    return { tools, close };
  } catch (error) { await close(); throw sanitizedError(error, redact); }
}
