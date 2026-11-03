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
  const remember = value => {
    if (!value) return;
    secrets.add(value);
    const authorization = value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (authorization) secrets.add(authorization[1]);
  };
  for (const key of ['headers', 'headersEnv', 'env']) if (definition[key] !== undefined && !isRecord(definition[key])) throw new TypeError(`${key} must be an object`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(definition.headers || {})) {
    if (typeof value !== 'string') throw new TypeError('Configured HTTP header values must be strings');
    headers.set(key, value); remember(value);
  }
  for (const [key, reference] of Object.entries(definition.headersEnv || {})) {
    const value = environmentValue(reference);
    headers.set(key, value); remember(value);
  }
  const environment = {};
  for (const [key, configured] of Object.entries(definition.env || {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new TypeError('Invalid configured environment name');
    const value = isRecord(configured) ? environmentValue(configured.env) : configured;
    if (typeof value !== 'string') throw new TypeError('Configured environment values must be strings or {env: name} references');
    environment[key] = value;
    if (value && (isRecord(configured) || /token|secret|password|api.?key|credential/i.test(key))) remember(value);
  }
  return { headers: Object.fromEntries(headers), environment };
}

function sanitizedError(error, redact) {
  const result = new Error(redact(error?.message || String(error)));
  result.name = error?.name || 'Error';
  for (const key of ['code', 'status', 'statusCode', 'outcomeUnknown']) if (error?.[key] !== undefined) result[key] = typeof error[key] === 'string' ? redact(error[key]) : error[key];
  if (error?.responseBody !== undefined) result.responseBody = sanitizeValue(error.responseBody, redact);
  return result;
}

function sanitizeValue(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, redact));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key),
    // Binary MCP blocks must retain their byte-for-byte content.
    key === 'data' && ['image', 'audio'].includes(value.type) ? item : sanitizeValue(item, redact)]));
}

const resultFields = new Set(['content', 'details', 'structuredContent', 'isError', '_meta', 'artifacts']);
function contentBlock(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image' || value.type === 'audio') return typeof value.data === 'string' && typeof value.mimeType === 'string';
  if (value.type === 'resource') return isRecord(value.resource) && typeof value.resource.uri === 'string' && (typeof value.resource.text === 'string' || typeof value.resource.blob === 'string');
  return value.type === 'resource_link' && typeof value.uri === 'string' && typeof value.name === 'string';
}
function toolResult(value, redact, type) {
  const cleaned = sanitizeValue(value, redact);
  // A normal REST collection may itself have a `content` array. Only preserve
  // recognizable tool envelopes, or SDK-validated MCP results, as native blocks.
  // In particular {content: [], total: n} is business JSON, not an empty reply.
  if (isRecord(cleaned) && Array.isArray(cleaned.content) && (type === 'mcp' ||
      (Object.keys(cleaned).every(key => resultFields.has(key)) && cleaned.content.every(contentBlock) &&
        (cleaned.content.length || ['details', 'structuredContent', 'isError', '_meta', 'artifacts'].some(key => Object.hasOwn(cleaned, key)))))) return cleaned;
  return { content: [{ type: 'text', text: typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned ?? null) }], details: cleaned };
}

const fieldPath = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
function inputField(input, path) {
  return path.split('.').reduce((value, part) => value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined, input);
}
function fieldMap(value, label) {
  if (!isRecord(value) || Object.entries(value).some(([key, path]) => !key || typeof path !== 'string' || !fieldPath.test(path))) {
    throw new TypeError(`${label} must map names to input field paths`);
  }
  return value;
}
function mappedInput(args, mapping) {
  return Object.fromEntries(Object.entries(mapping).flatMap(([name, path]) => {
    const value = inputField(args, path); return value === undefined ? [] : [[name, value]];
  }));
}
function unknownOutcome(error) {
  return Object.assign(new Error(`${error?.message || String(error)}. The remote outcome is unknown; query the original operation or external state before another write. This request was not retried.`),
    { name: error?.name || 'Error', outcomeUnknown: true, code: 'REMOTE_OUTCOME_UNKNOWN', ...(error?.status === undefined ? {} : { status: error.status }) });
}

function httpTool(definition, headers) {
  const baseUrl = new URL(definition.url);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new TypeError('HTTP tools require an HTTP(S) URL without embedded credentials');
  const method = String(definition.method || 'POST').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new TypeError('Unsupported HTTP method');
  if (definition.bodyMode !== undefined && !['arguments', 'raw', 'none'].includes(definition.bodyMode)) throw new TypeError('HTTP bodyMode must be arguments, raw or none');
  const request = definition.request || {};
  if (!isRecord(request) || Object.keys(request).some(key => !['path', 'query', 'body'].includes(key))) throw new TypeError('HTTP request accepts path, query and body mappings');
  const pathMapping = request.path === undefined ? {} : fieldMap(request.path, 'HTTP request.path');
  const queryMapping = request.query === undefined ? null : fieldMap(request.query, 'HTTP request.query');
  if (request.body !== undefined && !(typeof request.body === 'string' && fieldPath.test(request.body))) fieldMap(request.body, 'HTTP request.body');
  const noBody = ['GET', 'HEAD'].includes(method);
  if (noBody && request.body !== undefined) throw new TypeError(`${method} requests cannot contain a body`);
  const placeholders = [...baseUrl.pathname.matchAll(/(?:\{|%7B)([a-zA-Z0-9_-]+)(?:\}|%7D)/gi)].map(match => match[1]);
  if (/(?:\{|\}|%7[BD])/i.test(baseUrl.origin + baseUrl.search + baseUrl.hash)) throw new TypeError('HTTP URL placeholders are only allowed in the pathname');
  if (Object.keys(pathMapping).some(name => !placeholders.includes(name))) throw new TypeError('HTTP request.path contains a name absent from the URL pathname');
  const pathFields = new Set(placeholders.map(name => (pathMapping[name] || name).split('.')[0]));
  const effect = definition.effect || (['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'external');
  return { ...definition, effect,
    async execute(args, context) {
      const url = new URL(baseUrl), requestHeaders = new Headers(headers);
      if (definition.taskContext && context.taskId) requestHeaders.set('X-Summon-Task-Id', context.taskId);
      url.pathname = baseUrl.pathname.replace(/(?:\{|%7B)([a-zA-Z0-9_-]+)(?:\}|%7D)/gi, (_match, name) => {
        const value = inputField(args, pathMapping[name] || name);
        if (!['string', 'number', 'boolean'].includes(typeof value) || value === '' || value === '.' || value === '..') throw new TypeError(`Missing or invalid HTTP path parameter: ${name}`);
        return encodeURIComponent(String(value));
      });
      const query = queryMapping ? mappedInput(args, queryMapping) : noBody ? Object.fromEntries(Object.entries(args).filter(([key]) => !pathFields.has(key))) : {};
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        const values = Array.isArray(value) ? value : [value];
        if (values.some(item => !['string', 'number', 'boolean'].includes(typeof item))) throw new TypeError(`HTTP query parameter ${name} must be a scalar or scalar array`);
        url.searchParams.delete(name);
        for (const item of values) url.searchParams.append(name, String(item));
      }
      let body;
      if (!noBody && definition.bodyMode !== 'none') {
        const value = typeof request.body === 'string' ? inputField(args, request.body) : request.body ? mappedInput(args, request.body) : definition.bodyMode === 'raw' ? args : { arguments: args };
        if (value !== undefined) { body = JSON.stringify(value); if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json'); }
      }
      context.signal?.throwIfAborted();
      let response, text;
      try {
        response = await fetch(url, { method, headers: requestHeaders, redirect: 'error', signal: context.signal, ...(body === undefined ? {} : { body }) });
        text = await response.text();
      } catch (error) {
        // fetch/body-read failure gives no durable result for a mutation. Never
        // retry it here, including methods usually described as idempotent.
        if (effect !== 'read' && (!response || response.ok)) throw unknownOutcome(error);
        throw error;
      }
      let payload = text;
      if (response.headers.get('content-type')?.toLowerCase().includes('json')) {
        try { payload = text ? JSON.parse(text) : null; }
        catch {
          const error = Object.assign(new Error('HTTP tool returned invalid JSON'), { status: response.status });
          throw effect !== 'read' && response.ok ? unknownOutcome(error) : error;
        }
      }
      if (!response.ok) {
        const detail = isRecord(payload) ? payload.error?.message || payload.error || payload.message : payload;
        const code = isRecord(payload) ? payload.code ?? payload.error?.code : undefined;
        const outcomeUnknown = isRecord(payload) && (payload.outcomeUnknown === true || payload.error?.outcomeUnknown === true);
        throw Object.assign(new Error(`HTTP tool returned ${response.status}${detail ? `: ${String(detail).slice(0, 1200)}` : ''}`),
          { status: response.status, responseBody: payload,
            ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}), ...(outcomeUnknown ? { outcomeUnknown: true } : {}) });
      }
      return payload;
    },
  };
}

/** Explicit capability configuration only. HTTP defaults to POST {arguments: args};
 * bodyMode:'raw' sends args directly, 'none' omits the body. GET/HEAD put remaining
 * input fields in the query. Pathname {id} placeholders consume same-named input
 * fields. request:{path:{id:'object.id'},query:{limit:'limit'},body:'payload'}
 * maps dotted input fields explicitly; body may also be an output-name/field map.
 * headersEnv maps header names to environment names; stdio env entries may use
 * {env:'NAME'} to reference a credential. No automatic request retry occurs.
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
        tools.push({ name: tool.name, description: redact(tool.description), inputSchema: sanitizeValue(tool.inputSchema, redact), effect,
          classify: typeof tool.classify === 'function' ? (result, context) => tool.classify(result, context) : result => result?.isError ? 'failed' : 'completed',
          async execute(args, context = {}) {
            const executionSignal = signals(context.signal, AbortSignal.timeout(timeout));
            try {
              executionSignal.throwIfAborted();
              const result = await tool.execute(args, { ...context, botId, dataDir, workspace, signal: executionSignal });
              executionSignal.throwIfAborted();
              return toolResult(result, redact, definition.type);
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
