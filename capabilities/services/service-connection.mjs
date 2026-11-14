import { validateToolArguments } from '@earendil-works/pi-ai';
import { loadServiceMethods } from './service-transport.mjs';
import { keyOf, reject } from '../platform/contract.mjs';
import { connectionAllowed, plain } from './connection-records.mjs';
import { operationRecords, settled } from './session-processes.mjs';

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fieldPath = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const at = (value, path) => path?.split('.').reduce((part, key) =>
  part !== null && typeof part === 'object' && Object.hasOwn(part, key) ? part[key] : undefined, value);
const nativeId = value => ['number', 'string'].includes(typeof value) && String(value).length > 0 && String(value).length <= 512
  ? String(value) : undefined;
const statuses = ['completed', 'failed', 'stopped', 'running', 'needs_input'];
export const mcpTasksUnsupported = 'mcp_tasks_unsupported';

export const networkDefinitions = entry => entry.kind === 'http' ? entry.config.tools || [entry.config] : [entry.config];
export function credentialNames(entry) {
  if (entry.kind === 'cli' || entry.kind === 'codex') return entry.config.credential_refs || [];
  return networkDefinitions(entry).filter(plain).flatMap(definition =>
    [...Object.values(definition.headersEnv || {}), ...Object.values(definition.env || {}).map(ref => ref?.env)].filter(Boolean));
}

export function assertServiceConfig(entry) {
  const definitions = networkDefinitions(entry);
  if (!Array.isArray(definitions) || !definitions.length || definitions.length > 128) reject('invalid_connection', 'Specify 1–128 protocol definitions');
  for (const definition of definitions) {
    if (!plain(definition) || definition.type && definition.type !== entry.kind) reject('invalid_connection', 'Invalid protocol configuration');
    if (Object.keys(definition.headers || {}).length || Object.values(definition.headersEnv || {}).some(ref => !environmentName.test(ref)) ||
        Object.values(definition.env || {}).some(ref => !plain(ref) || !environmentName.test(ref.env)) ||
        Object.keys(definition).some(key => /^(?:token|password|secret|authorization|api[_-]?key)$/i.test(key))) {
      reject('invalid_credential', 'Use server-side environment references for connection credentials');
    }
    if (definition.url) {
      let url;
      try { url = new URL(definition.url); } catch { reject('invalid_connection', 'Specify a valid service URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          [...url.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key))) {
        reject('invalid_credential', 'The service URL must use HTTP(S) with credential references');
      }
    }
    if (entry.kind === 'http') {
      if (typeof definition.name !== 'string' || typeof definition.description !== 'string' ||
          definition.inputSchema?.type !== 'object' || typeof definition.url !== 'string') {
        reject('invalid_connection', 'HTTP methods require a name, description, object schema and URL');
      }
    } else if (!(definition.transport === 'http' && typeof definition.url === 'string') &&
        !(definition.transport === 'stdio' && typeof definition.command === 'string' && definition.command.trim())) {
      reject('invalid_connection', 'MCP transport must specify an HTTP URL or a stdio command');
    }
    if (definition.args !== undefined && (!Array.isArray(definition.args) || definition.args.some(value => typeof value !== 'string' ||
        /^--?(?:token|password|secret|api[_-]?key)(?:=|$)/i.test(value)))) {
      reject('invalid_connection', 'Stdio arguments must be strings with credential references in the environment');
    }
  }
  const lifecycle = entry.config.lifecycle;
  if (!lifecycle) return;
  if (entry.kind !== 'http' || !plain(lifecycle) || !fieldPath.test(lifecycle.operation_id_path || '') ||
      !fieldPath.test(lifecycle.status_path || '') || !plain(lifecycle.statuses) ||
      Object.values(lifecycle.statuses).some(status => !statuses.includes(status)) ||
      lifecycle.request_id_path && !fieldPath.test(lifecycle.request_id_path)) {
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

export class ServiceConnections {
  constructor(host) {
    this.host = host;
    this.sources = new Map();
    this.lifetime = new AbortController();
  }

  async source(entry, actor, workspace = this.host.workspace, signal) {
    const id = keyOf(entry.id, entry.revision, actor.id, workspace);
    let pending = this.sources.get(id);
    if (!pending) {
      const config = networkDefinitions(entry).map(({ taskContext, lifecycle, methods, ...definition }) => ({ ...definition, type: entry.kind }));
      pending = loadServiceMethods(config, { botId: actor.id, workspace, signal: this.lifetime.signal,
        redact: text => this.host.clean(text) });
      this.sources.set(id, pending);
      pending.catch(() => { if (this.sources.get(id) === pending) this.sources.delete(id); });
    }
    signal?.throwIfAborted();
    const source = await pending;
    signal?.throwIfAborted();
    return source;
  }

  async methods(entry, actor, signal) {
    const source = await this.source(entry, actor, undefined, signal);
    return source.tools.map(tool => ({ id: tool.name, name: tool.name, description: tool.description, input_schema: tool.inputSchema,
      ...(tool.requiresTasks ? { status: 'unsupported', code: mcpTasksUnsupported, task_support: 'required' } : {}) }));
  }

  async invoke(entry, actor, workspace, input, callId, beforeSubmit, signal, context = {}) {
    if (!plain(input) || typeof input.method !== 'string' || input.arguments !== undefined && !plain(input.arguments) ||
        Object.keys(input).some(key => !['method', 'arguments'].includes(key)))
      reject('invalid_service_input', 'Service input requires a method and optional arguments object');
    const source = await this.source(entry, actor, workspace, signal);
    const tool = source.tools.find(item => item.name === input.method);
    if (!tool) reject('method_not_found', 'The connection does not expose this protocol method', 404);
    if (tool.requiresTasks) reject(mcpTasksUnsupported, 'This MCP method requires the Tasks extension, which this connection does not support', 409);
    const args = validateToolArguments({ name: tool.name, parameters: tool.inputSchema },
      { id: callId, name: tool.name, arguments: input.arguments || {} });
    signal?.throwIfAborted();
    await beforeSubmit();
    signal?.throwIfAborted();
    try {
      return await tool.execute(args, { ...context, signal });
    } catch (error) {
      if (entry.kind === 'mcp' && ['CAPABILITY_UNAVAILABLE', 'REMOTE_OUTCOME_UNKNOWN'].includes(error.code)) {
        void this.disconnect(entry.id);
      }
      throw error;
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
    let carriedTarget = false;
    const context = {};
    if (kind === 'steer' || kind === 'reply') {
      const required = kind === 'reply' ? ['operation_id', 'input', 'request_id'] : ['operation_id', 'input'];
      const bindings = Object.entries(fields || { input: 'input', operation_id: 'operation_id', request_id: 'request_id' });
      context.onRequestFields = (sent, sentArgs) => {
        carriedTarget = required.every(value => bindings.some(([name, field]) => field === value &&
          (value === 'input' ? sent.has(name) || [...sent].some(path => path.startsWith(name + '.')) :
            sent.has(name) && nativeId(sentArgs[name]) === nativeId(values[value]))));
      };
    }
    const result = await this.invoke(entry, session.execution_actor, operation.cwd, { method, arguments: parameters }, callId, beforeSubmit, signal, context);
    const facts = this.facts(entry, result, operation);
    const echoedId = carriedTarget && nativeId(at(result?.details ?? result?.structuredContent ?? result, lifecycle.operation_id_path));
    return echoedId && echoedId === String(operation.operation_id) && !facts.rejected && facts.status !== 'unknown'
      ? { ...facts, confirmed_operation_id: echoedId } : facts;
  }

  async refresh(operation, entry, session) {
    if (this.host.locks.has(session.id)) return operation;
    if (!entry.config.lifecycle?.status_method || !operation.operation_id || !connectionAllowed(entry, session.execution_actor)) return operation;
    if (this.lifetime.signal.aborted || operation.last_poll_at && Date.now() - Date.parse(operation.last_poll_at) < 1500) return operation;
    operation = this.host.saveOperation(operation, { last_poll_at: new Date().toISOString() });
    try {
      const facts = await this.step(entry, session, operation, entry.config.lifecycle.status_method, undefined, operation.id, () => {
        const fresh = this.host.requireUsable(this.host.get(entry.id), session.execution_actor);
        if (fresh.revision !== entry.revision) reject('connection_binding_changed', 'Connection changed during observation', 409);
      });
      const latest = this.host.store.get(operationRecords, operation.id);
      if (this.host.locks.has(session.id) || latest?.last_poll_at !== operation.last_poll_at || latest?.updatedAt !== operation.updatedAt) return latest || operation;
      if (facts.rejected) return operation;
      if (facts.status === operation.status && facts.request_id === operation.request_id) return operation;
      return this.host.saveOperation(operation, facts);
    } catch { return operation; }
  }

  async disconnect(connectionId) {
    const retired = [...this.sources].filter(([id]) => JSON.parse(id)[0] === connectionId);
    await Promise.allSettled(retired.map(async ([id, source]) => {
      this.sources.delete(id);
      await (await source).close();
    }));
  }

  async close() {
    this.lifetime.abort();
    await Promise.allSettled([...this.sources.values()].map(async source => (await source).close()));
    this.sources.clear();
  }
}
