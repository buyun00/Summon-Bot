import { isDeepStrictEqual } from 'node:util';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { fieldPath, httpTool, loadServiceMethods } from './service-transport.mjs';
import { keyOf, reject } from '../platform/contract.mjs';
import { plain } from './connection-records.mjs';
import { operationRecords, settled } from './session-processes.mjs';
import { connectionExecutable } from './connection-launch.mjs';

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const publicHeaders = new Set(['accept', 'accept-language', 'content-type', 'content-language', 'prefer']);
const effects = new Set(['read', 'write', 'process', 'external']);
const at = (value, path) => path?.split('.').reduce((part, key) =>
  part !== null && typeof part === 'object' && Object.hasOwn(part, key) ? part[key] : undefined, value);
const nativeId = value => ['number', 'string'].includes(typeof value) && String(value).length > 0 && String(value).length <= 512
  ? String(value) : undefined;
const statuses = ['completed', 'failed', 'stopped', 'running', 'needs_input'];
export const mcpTasksUnsupported = 'mcp_tasks_unsupported';
export const mcpMethodUnsupported = 'mcp_method_unsupported';

const networkDefinitions = entry => entry.kind === 'http' ? entry.config.tools ?? [entry.config] : [entry.config];
const validPath = value => typeof value === 'string' && fieldPath.test(value);
export function serviceMethod(entry, name) {
  if (entry.kind !== 'http') return entry.config;
  const definitions = networkDefinitions(entry);
  const matching = Array.isArray(definitions) ? definitions.filter(definition => definition?.name === name) : [];
  if (matching.length > 1) reject('ambiguous_service_method', 'The HTTP method name is registered more than once', 409);
  return matching[0];
}

export function credentialNames(entry) {
  if (!plain(entry.config)) return [];
  if (entry.kind === 'cli' || entry.kind === 'codex') {
    return Array.isArray(entry.config.credential_refs) ? entry.config.credential_refs.filter(ref => typeof ref === 'string') : [];
  }
  const definitions = networkDefinitions(entry);
  return Array.isArray(definitions) ? definitions.filter(plain).flatMap(definition =>
    [...Object.values(definition.headersEnv || {}), ...Object.values(definition.env || {}).map(ref => ref?.env)]
      .filter(ref => typeof ref === 'string')) : [];
}

function assertDefinition(entry, definition) {
  if (!plain(definition) || definition.type && definition.type !== entry.kind) reject('invalid_connection', 'Invalid protocol configuration');
  if (['headers', 'headersEnv', 'env'].some(key => definition[key] !== undefined && !plain(definition[key])) ||
      Object.entries(definition.headers || {}).some(([header, value]) => !publicHeaders.has(header.toLowerCase()) || typeof value !== 'string') ||
      Object.values(definition.headersEnv || {}).some(ref => typeof ref !== 'string' || !environmentName.test(ref)) ||
      Object.entries(definition.env || {}).some(([name, ref]) => !environmentName.test(name) || !plain(ref) ||
        typeof ref.env !== 'string' || !environmentName.test(ref.env)) ||
      Object.keys(definition).some(key => /^(?:token|password|secret|authorization|api[_-]?key)$/i.test(key))) {
    reject('invalid_credential', 'Use server-side environment references for connection credentials');
  }
  try {
    new Headers(definition.headers);
    new Headers(Object.fromEntries(Object.keys(definition.headersEnv || {}).map(header => [header, ''])));
  } catch { reject('invalid_connection', 'Invalid configured HTTP header'); }
  if (definition.url) {
    let url;
    try { url = new URL(definition.url); } catch { reject('invalid_connection', 'Specify a valid service URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        [...url.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key))) {
      reject('invalid_credential', 'The service URL must use HTTP(S) with credential references');
    }
  }
  if (entry.kind === 'http') {
    if (typeof definition.name !== 'string' || !definition.name || typeof definition.description !== 'string' ||
        definition.inputSchema?.type !== 'object' || typeof definition.url !== 'string') {
      reject('invalid_connection', 'HTTP methods require a name, description, object schema and URL');
    }
    try { httpTool(definition); } catch (error) { reject('invalid_connection', error.message); }
  } else if (!(definition.transport === 'http' && typeof definition.url === 'string') &&
      !(definition.transport === 'stdio' && typeof definition.command === 'string' && definition.command.trim())) {
    reject('invalid_connection', 'MCP transport must specify an HTTP URL or a stdio command');
  }
  if (definition.args !== undefined && (!Array.isArray(definition.args) || definition.args.some(value => typeof value !== 'string' ||
      /^--?(?:token|password|secret|api[_-]?key)(?:=|$)/i.test(value)))) {
    reject('invalid_connection', 'Stdio arguments must be strings with credential references in the environment');
  }
  if (definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 300000))
    reject('invalid_connection', 'Capability timeoutMs must be an integer from 1 to 300000');
  if (definition.effect !== undefined && !effects.has(definition.effect)) reject('invalid_connection', 'Unknown service method effect');
}

export function assertServiceConfig(entry) {
  const definitions = networkDefinitions(entry);
  if (!Array.isArray(definitions) || !definitions.length || definitions.length > 128) reject('invalid_connection', 'Specify 1–128 protocol definitions');
  for (const definition of definitions) assertDefinition(entry, definition);
  if (entry.kind === 'http' && new Set(definitions.map(item => item.name)).size !== definitions.length)
    reject('invalid_connection', 'Configured HTTP method names must be unique');
  const lifecycle = entry.config.lifecycle;
  if (!lifecycle) return;
  if (entry.kind !== 'http' || !plain(lifecycle) || !validPath(lifecycle.operation_id_path) ||
      !validPath(lifecycle.status_path) || !plain(lifecycle.statuses) ||
      Object.values(lifecycle.statuses).some(status => !statuses.includes(status)) ||
      lifecycle.request_id_path && !validPath(lifecycle.request_id_path)) {
    reject('invalid_connection', 'Invalid HTTP asynchronous operation mapping');
  }
  if (lifecycle.method_arguments && (!plain(lifecycle.method_arguments) ||
      Object.entries(lifecycle.method_arguments).some(([name, mapping]) => !definitions.some(definition => definition.name === name) ||
        !plain(mapping) || Object.values(mapping).some(field => !['input', 'operation_id', 'request_id'].includes(field)))))
    reject('invalid_connection', 'Invalid HTTP operation argument mapping');
  for (const name of ['status_method', 'stop_method', 'reply_method', 'steer_method']) {
    if (lifecycle[name] && !definitions.some(definition => definition.name === lifecycle[name]))
      reject('invalid_connection', `Unknown configured ${name}`);
  }
  const statusMethod = definitions.find(definition => definition.name === lifecycle.status_method);
  if (statusMethod && !['GET', 'HEAD'].includes(String(statusMethod.method).toUpperCase()))
    reject('invalid_connection', 'HTTP operation status must use an actual read-only request');
}

function waitForSource(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([pending, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

export class ServiceConnections {
  constructor(host) {
    this.host = host;
    this.sources = new Map();
    this.lifetime = new AbortController();
  }

  async load(entry, definition, actor, workspace, signal) {
    assertDefinition(entry, definition);
    if (entry.kind === 'mcp' && definition.transport === 'stdio' && definition.canonical_command) {
      const command = await connectionExecutable({ config: { file: definition.command, canonical_file: definition.canonical_command } },
        workspace, this.host.dataRoot);
      definition = { ...definition, command };
    }
    return loadServiceMethods([{ ...definition, type: entry.kind }], { botId: actor.id, workspace,
      signal: signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal,
      redact: text => this.host.clean(text, []) });
  }

  sourceKey(entry, actor, workspace) { return keyOf(entry.id, actor.kind, actor.id, workspace); }

  async source(entry, actor, workspace, signal) {
    signal?.throwIfAborted();
    const id = this.sourceKey(entry, actor, workspace);
    let source = this.sources.get(id);
    if (source && (!isDeepStrictEqual(source.config, entry.config) || source.loaded?.connected() === false)) {
      void this.retire(id);
      source = null;
    }
    if (!source) {
      const controller = new AbortController();
      source = { controller, config: entry.config, waiting: 0 };
      source.pending = this.load(entry, entry.config, actor, workspace, controller.signal)
        .then(loaded => { source.loaded = loaded; return loaded; })
        .catch(error => {
          if (this.sources.get(id) === source) this.sources.delete(id);
          throw error;
        });
      this.sources.set(id, source);
    }
    source.waiting++;
    try {
      return await waitForSource(source.pending, signal);
    } finally {
      source.waiting--;
      if (!source.waiting && !source.loaded && this.sources.get(id) === source) {
        void this.retire(id);
      }
    }
  }

  async refreshMethods(entry, actor, workspace, source, signal) {
    try {
      await waitForSource(source.refresh(), signal);
      return source;
    } catch (error) {
      signal?.throwIfAborted();
      if (source.connected() && !(entry.config.transport === 'http' && [404, 410].includes(error.status ?? error.code)))
        throw error;
      const id = this.sourceKey(entry, actor, workspace);
      if (this.sources.get(id)?.loaded === source) void this.retire(id);
      return this.source(entry, actor, workspace, signal);
    }
  }

  async methods(entry, actor, workspace, signal) {
    if (entry.kind === 'http') {
      const definitions = networkDefinitions(entry);
      return Array.isArray(definitions) ? definitions.flatMap(definition => {
        if (typeof definition?.name !== 'string' || !definition.name) return [];
        const method = { id: definition.name, name: definition.name, description: definition.description, input_schema: definition.inputSchema };
        try {
          serviceMethod(entry, definition.name);
          assertDefinition(entry, definition);
          return [method];
        } catch (error) {
          return [{ id: definition.name, name: definition.name, status: 'unsupported', code: error.code, error: error.message }];
        }
      }) : [];
    }
    const cached = this.sources.get(this.sourceKey(entry, actor, workspace))?.loaded;
    let source = await this.source(entry, actor, workspace, signal);
    if (source === cached) source = await this.refreshMethods(entry, actor, workspace, source, signal);
    return source.tools.map(tool => ({ id: tool.name, name: tool.name, description: tool.description, input_schema: tool.inputSchema,
      ...(tool.unavailable ? { status: 'unsupported', code: mcpMethodUnsupported, error: tool.unavailable } : {}),
      ...(tool.requiresTasks ? { status: 'unsupported', code: mcpTasksUnsupported, task_support: 'required' } : {}) }));
  }

  async invoke(entry, actor, workspace, input, callId, beforeSubmit, signal, context = {}) {
    if (!plain(input) || typeof input.method !== 'string' || input.arguments !== undefined && !plain(input.arguments) ||
        Object.keys(input).some(key => !['method', 'arguments'].includes(key)))
      reject('invalid_service_input', 'Service input requires a method and optional arguments object');
    signal?.throwIfAborted();
    const http = entry.kind === 'http';
    let source;
    try {
      if (http) {
        const definition = serviceMethod(entry, input.method);
        if (!definition) reject('method_not_found', 'The connection does not expose this HTTP method', 404);
        source = await this.load(entry, definition, actor, workspace, signal);
      } else {
        source = await this.source(entry, actor, workspace, signal);
      }
      let tool = source.tools.find(item => item.name === input.method);
      if (!tool && !http) {
        source = await this.refreshMethods(entry, actor, workspace, source, signal);
        tool = source.tools.find(item => item.name === input.method);
      }
      if (!tool) reject('method_not_found', 'The connection does not expose this protocol method', 404);
      if (tool.unavailable) reject(mcpMethodUnsupported, tool.unavailable, 409);
      if (tool.requiresTasks) reject(mcpTasksUnsupported, 'This MCP method requires the Tasks extension, which this connection does not support', 409);
      const args = validateToolArguments({ name: tool.name, parameters: tool.inputSchema },
        { id: callId, name: tool.name, arguments: input.arguments || {} });
      return await tool.execute(args, { ...context, beforeSubmit, signal });
    } catch (error) {
      if (!http && source && ['CAPABILITY_UNAVAILABLE', 'REMOTE_OUTCOME_UNKNOWN'].includes(error.code)) {
        const id = this.sourceKey(entry, actor, workspace);
        if (this.sources.get(id)?.loaded === source) void this.retire(id);
      }
      if (error.code === 'connection_credential_missing') error.message = `${input.method}: ${error.message}`;
      throw error;
    } finally {
      if (http) await source?.close();
    }
  }

  facts(entry, result, prior) {
    if (result?.isError) return { status: 'failed', result, runtime_ended: true, rejected: true };
    const config = entry.config.lifecycle;
    const payload = result?.details ?? result?.structuredContent ?? result;
    const operationId = at(payload, config?.operation_id_path);
    if (operationId !== undefined && prior?.operation_id !== undefined && String(operationId) !== String(prior.operation_id))
      return { status: 'unknown', error: 'The service returned a different operation identity' };
    const native = operationId ?? prior?.operation_id;
    const reported = at(payload, config?.status_path);
    const stated = config && Object.hasOwn(config.statuses, reported) ? config.statuses[reported] : undefined;
    const accepted = entry.kind === 'http' && result?.http_status === 202;
    const status = accepted ? (stated && !settled(stated) ? stated : 'submitted') : config && (nativeId(native) || stated) ?
      (stated && (nativeId(native) || settled(stated)) ? stated : 'unknown') : 'completed';
    return { status, result, service_accepted: accepted, operation_id: nativeId(native) ? native : undefined,
      runtime_ended: settled(status) && status !== 'unknown',
      ...(status === 'needs_input' ? { request_id: nativeId(at(payload, config.request_id_path)) } : { request_id: null }) };
  }

  async step(entry, session, operation, method, input, callId, beforeSubmit, signal, kind) {
    if (!method) reject('operation_unsupported', 'The external protocol does not provide this operation', 409);
    const lifecycle = entry.config.lifecycle;
    const fields = lifecycle.method_arguments?.[method];
    const values = { input, operation_id: operation.operation_id, request_id: operation.request_id };
    const args = { ...(input === undefined ? {} : { input }), operation_id: operation.operation_id,
      ...(operation.request_id ? { request_id: operation.request_id } : {}) };
    const parameters = fields ? Object.fromEntries(Object.entries(fields).flatMap(([name, field]) =>
      Object.hasOwn(values, field) && values[field] !== undefined && values[field] !== null ? [[name, values[field]]] : [])) : args;
    const inputCall = kind === 'steer' || kind === 'reply';
    const required = ['operation_id', ...(inputCall ? ['input'] : []), ...(kind === 'reply' ? ['request_id'] : [])];
    const bindings = Object.entries(fields || { input: 'input', operation_id: 'operation_id', request_id: 'request_id' });
    const context = { onRequestFields(sent, sentArgs) {
      const missing = required.find(value => !bindings.some(([name, field]) => field === value &&
        (value === 'input' ? sent.has(name) || [...sent].some(path => path.startsWith(name + '.')) :
          sent.has(name) && nativeId(sentArgs[name]) === nativeId(values[value]))));
      if (missing) reject('service_target_unmapped', `The selected HTTP method does not send the original ${missing}`, 409);
    } };
    const result = await this.invoke(entry, session.execution_actor, operation.cwd, { method, arguments: parameters }, callId, beforeSubmit, signal, context);
    const facts = this.facts(entry, result, operation);
    const echoedId = inputCall && nativeId(at(result?.details ?? result?.structuredContent ?? result, lifecycle.operation_id_path));
    return echoedId && echoedId === String(operation.operation_id) && !facts.rejected && facts.status !== 'unknown'
      ? { ...facts, confirmed_operation_id: echoedId } : facts;
  }

  async refresh(operation, entry, session) {
    if (this.host.locks.has(session.id)) return operation;
    if (!entry.config.lifecycle?.status_method || !operation.operation_id) return operation;
    if (this.lifetime.signal.aborted || operation.last_poll_at && Date.now() - Date.parse(operation.last_poll_at) < 1500) return operation;
    operation = this.host.saveOperation(operation, { last_poll_at: new Date().toISOString() });
    try {
      const method = entry.config.lifecycle.status_method;
      const facts = await this.step(entry, session, operation, method, undefined, operation.id,
        () => this.host.requireObservation(entry, session, operation, method));
      const latest = this.host.store.get(operationRecords, operation.id);
      if (this.host.locks.has(session.id) || latest?.last_poll_at !== operation.last_poll_at || latest?.updatedAt !== operation.updatedAt) return latest || operation;
      if (facts.rejected) return operation;
      if (facts.status === operation.status && facts.request_id === operation.request_id) return operation;
      return this.host.saveOperation(operation, facts);
    } catch { return operation; }
  }

  async retire(id) {
    const source = this.sources.get(id);
    if (!source) return;
    this.sources.delete(id);
    source.controller.abort();
    try { await (await source.pending).close(); } catch { /* Failed initialization already closed its transport. */ }
  }

  async disconnect(connectionId) {
    await Promise.all([...this.sources.keys()].filter(id => JSON.parse(id)[0] === connectionId).map(id => this.retire(id)));
  }

  async close() {
    this.lifetime.abort();
    await Promise.all([...this.sources.keys()].map(id => this.retire(id)));
  }
}
