import { createHash, randomUUID } from 'node:crypto';

const kinds = Object.freeze({ services: 'capability-services', versions: 'capability-versions', actors: 'capability-actors', proposals: 'capability-proposals', requests: 'capability-requests' });
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const effects = new Set(['read', 'write', 'process', 'external']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (message, status = 400, code = 'CAPABILITY_INVALID') => Object.assign(new Error(message), { status, statusCode: status, code });
const keyOf = (id, version) => `${id}@${version}`;

function checkedId(value, label) {
  if (typeof value !== 'string' || !identifier.test(value)) throw fail(`Invalid capability ${label}`);
  return value;
}

function checkedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('Capability endpoint must be an HTTP(S) URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback) || url.username || url.password || url.search || url.hash) throw fail('Capability endpoint requires HTTPS or loopback HTTP, without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}

function checkedTools(value) {
  if (!Array.isArray(value) || value.length > 1024) throw fail('Capability manifest requires at most 1024 tools');
  const names = new Set();
  return value.map(tool => {
    if (!plain(tool) || !toolName.test(tool.name) || typeof tool.description !== 'string' || tool.description.length > 16384 || !plain(tool.inputSchema) || tool.inputSchema.type !== 'object' || !effects.has(tool.effect || 'external')) throw fail('Invalid capability tool definition');
    if (names.has(tool.name)) throw fail(`Duplicate capability tool: ${tool.name}`, 409, 'CAPABILITY_TOOL_COLLISION');
    names.add(tool.name);
    return { name: tool.name, description: tool.description, inputSchema: copy(tool.inputSchema), effect: tool.effect || 'external' };
  });
}

function checkedAllowed(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Set) value = [...value];
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !toolName.test(name))) throw fail('Allowed tool names must be an array or Set of tool names');
  return [...new Set(value)].sort();
}

/** Durable capability routing. A single gateway owns this registry; workers own
 * their execution and data. Registering a service never grants tool access.
 * Ordinary actors stay pinned until the gateway completes their readiness
 * handshake and commits a proposal. The controller always uses active routes.
 */
export class CapabilityRegistry {
  constructor({ store, fetch: request = globalThis.fetch, emit = () => {}, reservedTools = [], manifestTimeoutMs = 10000, requestHistoryLimit = 1000 } = {}) {
    if (!store?.transaction || typeof request !== 'function') throw new TypeError('CapabilityRegistry requires a RecordStore and fetch');
    if (!Number.isSafeInteger(requestHistoryLimit) || requestHistoryLimit < 0 || requestHistoryLimit > 100000) throw new TypeError('Capability request history limit must be between 0 and 100000');
    this.store = store;
    this.fetch = request;
    this.emit = emit;
    this.reservedTools = new Set(reservedTools);
    this.manifestTimeoutMs = manifestTimeoutMs;
    this.requestHistoryLimit = requestHistoryLimit;
    this.inFlight = new Map();
    // A gateway crash cannot establish the outcome of a remote mutation. Do
    // not silently mark those calls drained or repeat them on restart.
    this.store.transaction(() => {
      for (const record of this.store.list(kinds.requests)) if (record.status === 'running') this.store.save(kinds.requests, { ...record, status: 'unknown', reason: 'gateway-restarted' });
    });
  }

  _emit(type, data) { try { this.emit(type, copy(data)); } catch { /* Observers cannot roll back a committed registry change. */ } }
  _publicVersion(record) {
    if (!record) return undefined;
    const { token, ...safe } = record;
    return copy(safe);
  }
  _redact(value) {
    let text = String(value);
    for (const record of this.store.list(kinds.versions)) if (record.token) text = text.split(record.token).join('[redacted]');
    return text;
  }
  _finishRequest(record) {
    return this.store.transaction(() => {
      const updated = this.store.save(kinds.requests, record);
      const terminal = this.store.list(kinds.requests).filter(item => ['completed', 'failed'].includes(item.status));
      for (const item of terminal.slice(0, Math.max(0, terminal.length - this.requestHistoryLimit))) this.store.remove(kinds.requests, item.id);
      return updated;
    });
  }
  _actor(actor) {
    if (typeof actor !== 'string' || !actor || actor.length > 256 || /[\x00-\x1f]/.test(actor)) throw fail('Invalid capability actor');
    return this.store.get(kinds.actors, actor);
  }
  _desired(allowedNames) {
    const allowed = allowedNames === null ? null : new Set(allowedNames);
    const bindings = {};
    for (const service of this.store.list(kinds.services)) {
      if (service.status !== 'active' || !service.activeVersion) continue;
      const version = this.store.get(kinds.versions, keyOf(service.id, service.activeVersion));
      if (version && (!allowed || version.tools.some(tool => allowed.has(tool.name)))) bindings[service.id] = service.activeVersion;
    }
    return bindings;
  }
  _tools(bindings, allowedNames) {
    const allowed = allowedNames === null ? null : new Set(allowedNames);
    return Object.entries(bindings).flatMap(([id, version]) => this.store.get(kinds.versions, keyOf(id, version))?.tools.filter(tool => !allowed || allowed.has(tool.name)).map(copy) || []);
  }

  async _verifiedRegistration(input) {
    if (!plain(input)) throw fail('Capability registration must be an object');
    const id = checkedId(input.id, 'id'), version = checkedId(input.version, 'version'), endpoint = checkedEndpoint(input.endpoint);
    if (input.token !== undefined && (typeof input.token !== 'string' || /[\r\n]/.test(input.token) || input.token.length > 16384)) throw fail('Invalid capability service token');
    const headers = input.token ? { Authorization: `Bearer ${input.token}` } : {};
    let manifest;
    try {
      const response = await this.fetch(`${endpoint}/manifest`, { headers, redirect: 'error', signal: AbortSignal.timeout(this.manifestTimeoutMs) });
      if (!response.ok) throw fail(`Capability manifest returned HTTP ${response.status}`, 502, 'CAPABILITY_MANIFEST_FAILED');
      const body = await response.text();
      if (Buffer.byteLength(body) > 1024 * 1024) throw fail('Capability manifest exceeds 1 MiB', 502, 'CAPABILITY_MANIFEST_FAILED');
      manifest = JSON.parse(body);
    } catch (error) {
      // Keep remote bodies, URLs and credentials out of registration failures.
      if (error.code === 'CAPABILITY_MANIFEST_FAILED') throw error;
      throw fail('Capability manifest could not be verified', 502, 'CAPABILITY_MANIFEST_FAILED');
    }
    if (!plain(manifest) || manifest.id !== id || manifest.version !== version) throw fail('Capability manifest identity does not match registration', 409, 'CAPABILITY_MANIFEST_MISMATCH');
    const tools = checkedTools(manifest.tools);
    const stateVersion = manifest.stateVersion ?? '1';
    if (typeof stateVersion !== 'string' || !identifier.test(stateVersion)) throw fail('Invalid capability stateVersion');
    if ((input.stateVersion !== undefined && input.stateVersion !== stateVersion) || (input.tools !== undefined && canonical(checkedTools(input.tools)) !== canonical(tools))) throw fail('Capability manifest does not match the declared schema', 409, 'CAPABILITY_MANIFEST_MISMATCH');
    return { id: keyOf(id, version), capabilityId: id, version, endpoint, token: input.token || '', tools, stateVersion };
  }
  async register(input) {
    const record = await this._verifiedRegistration(input);
    const { capabilityId: id, version, tools } = record;
    const result = this.store.transaction(() => {
      const existing = this.store.get(kinds.versions, record.id);
      if (existing) {
        const { createdAt, updatedAt, ...identity } = existing;
        if (canonical(identity) !== canonical(record)) throw fail('A registered capability version is immutable; publish a new version', 409, 'CAPABILITY_VERSION_IMMUTABLE');
        return existing;
      }
      const names = new Set(tools.map(tool => tool.name));
      for (const name of names) if (this.reservedTools.has(name)) throw fail(`Capability tool name is reserved: ${name}`, 409, 'CAPABILITY_TOOL_COLLISION');
      for (const other of this.store.list(kinds.versions)) if (other.capabilityId !== id) for (const tool of other.tools) if (names.has(tool.name)) throw fail(`Capability tool is already owned by ${other.capabilityId}: ${tool.name}`, 409, 'CAPABILITY_TOOL_COLLISION');
      this.store.save(kinds.services, { id, ...(this.store.get(kinds.services, id) || { status: 'registered', activeVersion: null }) });
      return this.store.save(kinds.versions, record);
    });
    this._emit('capability.registered', { id, version });
    return this._publicVersion(result);
  }

  async relocate(id, version, coordinates) {
    const original = this.store.get(kinds.versions, keyOf(id, version));
    if (!original) throw fail('Capability version is not registered', 404, 'CAPABILITY_NOT_FOUND');
    const candidate = await this._verifiedRegistration({ id, version, endpoint: coordinates?.endpoint, token: coordinates?.token ?? original.token, tools: original.tools, stateVersion: original.stateVersion });
    const updated = this.store.transaction(() => {
      const current = this.store.get(kinds.versions, original.id);
      if (current.endpoint !== original.endpoint || current.token !== original.token) throw fail('Capability coordinates changed during relocation', 409, 'CAPABILITY_RELOCATION_STALE');
      return this.store.save(kinds.versions, candidate);
    });
    this._emit('capability.relocated', { id, version });
    return this._publicVersion(updated);
  }

  getVersion(id, version, { private: includePrivate = false } = {}) {
    const record = this.store.get(kinds.versions, keyOf(id, version));
    return includePrivate ? (record && copy(record)) : this._publicVersion(record);
  }
  active(id) {
    const service = this.store.get(kinds.services, id);
    return service?.status === 'active' && service.activeVersion ? this.getVersion(id, service.activeVersion) : undefined;
  }
  activate(id, version) {
    const result = this.store.transaction(() => {
      const target = this.store.get(kinds.versions, keyOf(id, version));
      if (!target) throw fail('Capability version is not registered', 404, 'CAPABILITY_NOT_FOUND');
      const service = this.store.get(kinds.services, id);
      if (service?.stateVersion && service.stateVersion !== target.stateVersion) throw fail('Capability stateVersion changes require a separate data migration', 409, 'CAPABILITY_STATE_MIGRATION_REQUIRED');
      this.store.save(kinds.services, { id, status: 'active', activeVersion: version, stateVersion: target.stateVersion });
      for (const actor of this.store.list(kinds.actors)) this.propose(actor.id);
      return this._publicVersion(target);
    });
    this._emit('capability.activated', { id, version });
    return result;
  }
  publish(id, version) { return this.activate(id, version); }
  unload(id) {
    const result = this.store.transaction(() => {
      if (!this.store.get(kinds.services, id)) throw fail('Capability is not registered', 404, 'CAPABILITY_NOT_FOUND');
      const service = this.store.save(kinds.services, { id, status: 'draining', activeVersion: null });
      for (const actor of this.store.list(kinds.actors)) this.propose(actor.id);
      return copy(service);
    });
    this._emit('capability.unloading', { id });
    return result;
  }

  registerActor(actor, allowedNames) {
    const existing = this._actor(actor);
    if (actor === 'controller') return { id: actor, revision: 0, allowedNames: checkedAllowed(allowedNames), bindings: this._desired(checkedAllowed(allowedNames)) };
    if (existing) return copy(existing);
    const allowed = checkedAllowed(allowedNames);
    return copy(this.store.save(kinds.actors, { id: actor, revision: 0, allowedNames: allowed, desiredAllowedNames: allowed, bindings: this._desired(allowed) }));
  }
  bindingsFor(actor) {
    if (actor === 'controller') return this._desired(null);
    return copy((this._actor(actor) || this.registerActor(actor)).bindings);
  }
  toolsFor(actor, allowedNames) {
    let record = this._actor(actor) || this.registerActor(actor, allowedNames);
    if (actor === 'controller') return this._tools(this._desired(checkedAllowed(allowedNames)), checkedAllowed(allowedNames));
    if (allowedNames !== undefined) {
      const allowed = checkedAllowed(allowedNames);
      if (canonical(allowed) !== canonical(Object.hasOwn(record, 'desiredAllowedNames') ? record.desiredAllowedNames : record.allowedNames)) record = this.store.save(kinds.actors, { ...record, desiredAllowedNames: allowed });
    }
    return this._tools(record.bindings, record.allowedNames);
  }
  propose(actor, allowedNames) {
    if (actor === 'controller') return null;
    let record = this._actor(actor) || this.registerActor(actor, allowedNames);
    if (allowedNames !== undefined) {
      const allowed = checkedAllowed(allowedNames);
      if (canonical(allowed) !== canonical(Object.hasOwn(record, 'desiredAllowedNames') ? record.desiredAllowedNames : record.allowedNames)) record = this.store.save(kinds.actors, { ...record, desiredAllowedNames: allowed });
    }
    const desiredAllowedNames = Object.hasOwn(record, 'desiredAllowedNames') ? record.desiredAllowedNames : record.allowedNames;
    const bindings = this._desired(desiredAllowedNames);
    const fingerprint = digest({ bindings, allowedNames: desiredAllowedNames });
    const pending = this.store.list(kinds.proposals).filter(proposal => proposal.actor === actor && proposal.status === 'pending');
    const prior = pending.find(proposal => proposal.expectedRevision === record.revision && proposal.fingerprint === fingerprint);
    // Even when no routing changes remain, obsolete prepared proposals must
    // cease to be commit candidates (for example v2 activation rolled back).
    for (const item of pending) if (item !== prior) this.store.save(kinds.proposals, { id: item.id, status: 'superseded' });
    if (canonical(bindings) === canonical(record.bindings) && canonical(desiredAllowedNames) === canonical(record.allowedNames)) {
      if (prior) this.store.save(kinds.proposals, { id: prior.id, status: 'superseded' });
      return null;
    }
    if (prior) return copy(prior);
    const proposal = this.store.save(kinds.proposals, { id: randomUUID(), actor, status: 'pending', expectedRevision: record.revision, revision: record.revision + 1, bindings, previousBindings: copy(record.bindings), allowedNames: copy(desiredAllowedNames), fingerprint, tools: this._tools(bindings, desiredAllowedNames) });
    this._emit('capability.switch-available', { actor, proposalId: proposal.id, revision: proposal.revision, bindings });
    return copy(proposal);
  }
  pending(actor) { return this.store.list(kinds.proposals).filter(proposal => proposal.status === 'pending' && (actor === undefined || proposal.actor === actor)).map(copy); }
  commit(actor, proposalId) {
    const result = this.store.transaction(() => {
      const proposal = this.store.get(kinds.proposals, proposalId), record = this._actor(actor);
      if (!proposal || proposal.actor !== actor || !record) throw fail('Capability proposal was not found for this actor', 404, 'CAPABILITY_PROPOSAL_NOT_FOUND');
      if (proposal.status === 'committed') return copy(proposal.committedActor);
      const desiredAllowedNames = Object.hasOwn(record, 'desiredAllowedNames') ? record.desiredAllowedNames : record.allowedNames;
      if (proposal.status !== 'pending' || proposal.expectedRevision !== record.revision || proposal.fingerprint !== digest({ bindings: this._desired(desiredAllowedNames), allowedNames: desiredAllowedNames })) throw fail('Capability proposal became stale; prepare the latest proposal', 409, 'CAPABILITY_PROPOSAL_STALE');
      const updated = this.store.save(kinds.actors, { ...record, revision: proposal.revision, bindings: proposal.bindings, allowedNames: proposal.allowedNames, lastProposalId: proposalId });
      this.store.save(kinds.proposals, { id: proposalId, status: 'committed', committedActor: copy(updated) });
      return copy(updated);
    });
    this._emit('capability.switched', { actor, proposalId, revision: result.revision, bindings: result.bindings });
    return result;
  }
  forgetActor(actor) {
    const removed = this.store.transaction(() => {
      for (const proposal of this.pending(actor)) this.store.save(kinds.proposals, { id: proposal.id, status: 'superseded' });
      return this.store.remove(kinds.actors, actor);
    });
    if (removed) this._emit('capability.actor-forgotten', { actor });
    return removed;
  }

  async call(actor, name, args, options = {}) {
    const record = actor === 'controller' ? { bindings: this._desired(null), allowedNames: null } : this._actor(actor) || this.registerActor(actor);
    const allowed = Object.hasOwn(record, 'desiredAllowedNames') ? record.desiredAllowedNames : record.allowedNames;
    if (allowed !== null && !allowed.includes(name)) throw fail(`Capability tool is not allowed: ${name}`, 403, 'CAPABILITY_FORBIDDEN');
    for (const [id, version] of Object.entries(record.bindings)) if (this.store.get(kinds.versions, keyOf(id, version))?.tools.some(tool => tool.name === name)) return this.callVersion(id, version, name, args, { ...options, context: { ...options.context, actor } });
    throw fail(`Capability tool is not bound: ${name}`, 404, 'CAPABILITY_TOOL_NOT_BOUND');
  }
  async callVersion(id, version, name, args, { signal, context = {} } = {}) {
    const target = this.store.get(kinds.versions, keyOf(id, version));
    if (!target?.tools.some(tool => tool.name === name)) throw fail('Capability version does not provide this tool', 404, 'CAPABILITY_TOOL_NOT_FOUND');
    return this._invoke(target, `/tools/${encodeURIComponent(name)}`, name, args, { signal, context });
  }
  async invokeVersion(id, version, operation, args, { signal, context = {} } = {}) {
    const target = this.store.get(kinds.versions, keyOf(id, version));
    if (!target) throw fail('Capability version is not registered', 404, 'CAPABILITY_NOT_FOUND');
    if (typeof operation !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(operation)) throw fail('Invalid capability RPC operation');
    return this._invoke(target, `/rpc/${encodeURIComponent(operation)}`, `rpc:${operation}`, args, { signal, context });
  }
  async _invoke(target, path, name, args, { signal, context }) {
    const { capabilityId: id, version } = target;
    signal?.throwIfAborted();
    const requestId = randomUUID(), key = target.id;
    const body = JSON.stringify({ arguments: args, context: { ...context, capabilityId: id, capabilityVersion: version, requestId } });
    this.store.save(kinds.requests, { id: requestId, capabilityId: id, version, tool: name, actor: typeof context.actor === 'string' ? context.actor : 'controller', status: 'running' });
    this.inFlight.set(key, (this.inFlight.get(key) || 0) + 1);
    let received = false;
    try {
      const response = await this.fetch(`${target.endpoint}${path}`, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) }, body });
      const responseBody = await response.text();
      let payload;
      try { payload = responseBody ? JSON.parse(responseBody) : null; } catch { throw fail('Capability service returned invalid JSON', 502, 'CAPABILITY_RESPONSE_INVALID'); }
      received = true;
      if (!response.ok) {
        const detail = plain(payload) ? payload.error?.message || payload.error || payload.message : undefined;
        throw fail(`Capability service returned HTTP ${response.status}${typeof detail === 'string' ? `: ${this._redact(detail).slice(0, 1200)}` : ''}`, response.status, 'CAPABILITY_REMOTE_ERROR');
      }
      this._finishRequest({ id: requestId, status: 'completed', finishedAt: new Date().toISOString() });
      return payload;
    } catch (error) {
      const status = received ? 'failed' : 'unknown';
      this._finishRequest({ id: requestId, status, finishedAt: new Date().toISOString(), reason: received ? 'remote-error' : 'remote-outcome-unknown' });
      const failure = fail(received ? this._redact(error.message) : 'Capability request outcome is unknown; it was not retried', received ? error.status || 502 : 502, received ? error.code || 'CAPABILITY_REMOTE_ERROR' : 'CAPABILITY_OUTCOME_UNKNOWN');
      failure.requestId = requestId;
      failure.outcome = status;
      throw failure;
    } finally {
      const count = (this.inFlight.get(key) || 1) - 1;
      if (count) this.inFlight.set(key, count); else this.inFlight.delete(key);
    }
  }
  resolveRequest(requestId, { outcome } = {}) {
    if (!['completed', 'failed'].includes(outcome)) throw fail('Reconciled request outcome must be completed or failed');
    const request = this.store.get(kinds.requests, requestId);
    if (!request) throw fail('Capability request was not found', 404, 'CAPABILITY_REQUEST_NOT_FOUND');
    if (request.status !== 'unknown') throw fail('Only unknown capability requests require reconciliation', 409, 'CAPABILITY_REQUEST_NOT_UNKNOWN');
    const result = this._finishRequest({ id: requestId, status: outcome, reconciledAt: new Date().toISOString() });
    this._emit('capability.request-reconciled', { requestId, outcome });
    return copy(result);
  }

  inventory() {
    const actors = this.store.list(kinds.actors), requests = this.store.list(kinds.requests), services = this.store.list(kinds.services);
    const versions = this.store.list(kinds.versions).map(record => {
      const service = services.find(item => item.id === record.capabilityId);
      const bindings = actors.filter(actor => actor.bindings[record.capabilityId] === record.version).map(actor => actor.id);
      const inFlight = this.inFlight.get(record.id) || 0;
      const unknownRequests = requests.filter(request => request.capabilityId === record.capabilityId && request.version === record.version && ['unknown', 'running'].includes(request.status)).map(copy);
      const accepting = service?.status === 'active' && service.activeVersion === record.version;
      return { ...this._publicVersion(record), accepting, bindings, bindingCount: bindings.length, inFlight, unknownRequests, retirementReady: !accepting && bindings.length === 0 && inFlight === 0 && unknownRequests.length === 0 };
    });
    return { services: services.map(copy), versions, bindings: actors.map(copy), pending: this.pending(), routes: services.filter(service => service.status === 'active').map(service => ({ id: service.id, version: service.activeVersion })) };
  }
}
