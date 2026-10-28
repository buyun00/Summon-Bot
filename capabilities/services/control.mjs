import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from './supervisor.mjs';
import { WorkspaceExecutionLock } from '../shared/workspace-lock.mjs';
import { fail } from '../shared/validation.mjs';
import { loadConfiguredTools } from '../../bot/src/capabilities/remote-tools.mjs';
import { coreTools } from '../../bot/src/capabilities/core-tools.mjs';

const object = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true });
const text = { type: 'string' }, names = { type: 'array', items: text };
export const controlTools = [
  ['capabilities_list', 'Inspect a compact paginated capability inventory; filter id or botId and use nextOffset for more. Tool schemas are omitted.', 'read', object({ id: text, botId: text, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } })],
  ['capabilities_register', 'Register an independent API/MCP service manifest; registration does not grant access', 'external', object({ id: text, version: text, endpoint: text, token: text }, ['id', 'version', 'endpoint'])],
  ['capabilities_deploy', 'Deploy an immutable capability package or verified release through the configured publisher', 'external',
    { ...object({ id: text, version: text, packageRoot: text, releaseRoot: text, activate: { type: 'boolean' }, options: object() }, ['id', 'version']),
      oneOf: [{ required: ['packageRoot'], not: { required: ['releaseRoot'] } }, { required: ['releaseRoot'], not: { required: ['packageRoot'] } }], additionalProperties: false }],
  ['capabilities_activate', 'Publish a registered version; notify existing Bots and wait for their task boundary', 'external', object({ id: text, version: text }, ['id', 'version'])],
  ['capabilities_unload', 'Remove a capability from future bindings; drain existing Bots cooperatively', 'external', object({ id: text }, ['id'])],
  ['capabilities_grant', 'Set the explicitly authorized capability tool names for a managed Bot', 'external', object({ botId: text, tools: names }, ['botId', 'tools'])],
  ['capabilities_retry', 'Explicitly retry a failed or blocked Bot capability switch after inspecting its error', 'external', object({ botId: text }, ['botId'])],
  ['capabilities_reconcile', 'Resolve an unknown request only after verifying its actual outcome; retain the supplied evidence', 'external',
    object({ requestId: text, outcome: { type: 'string', enum: ['completed', 'failed'] }, evidence: { type: 'string', minLength: 1, maxLength: 16384 } }, ['requestId', 'outcome', 'evidence'])],
  ['capabilities_retire', 'Stop an unused managed capability version after all Bots and jobs drain', 'external', object({ id: text, version: text }, ['id', 'version'])],
].map(([name, description, effect, inputSchema]) => ({ name, description, effect, inputSchema }));

const reason = '能力服务版本已发布，请在当前任务结束后切换。';
const now = () => new Date().toISOString();
const pending = transition => transition && transition.phase !== 'complete';

/** Durable coordinator: routing is committed while the Bot holds its task gate.
 * Immutable, version-pinned tool snapshots survive the gap between the registry
 * and Bot commits. Both versions remain retained until the Bot acknowledges. */
export class CapabilityControl {
  constructor({ registry, supervisor, manager, store, gatewayUrl, emit = () => {}, deploy, retryBaseMs = 1000, maxRetries = 3, clock = Date.now }) {
    Object.assign(this, { registry, supervisor, manager, store, gatewayUrl, emit, deploy, retryBaseMs, maxRetries, clock });
    this.running = false; this.closed = false; this.stopping = new AbortController(); this.capabilityOperations = new Map();
  }
  tools(bot, definitions = this.registry.toolsFor(bot.id, bot.allowedTools), bindings = this.registry.bindingsFor(bot.id), allowedNames) {
    const allowed = allowedNames ?? this.registry.registerActor(bot.id, bot.allowedTools).allowedNames ?? [];
    const owner = name => Object.entries(bindings).find(([id, version]) => this.registry.getVersion(id, version)?.tools.some(tool => tool.name === name));
    return [...definitions, ...controlTools.filter(tool => allowed.includes(tool.name))].map(tool => {
      const route = owner(tool.name);
      return { ...tool, type: 'http', method: 'POST', url: route ? `${this.gatewayUrl()}/capabilities/${encodeURIComponent(route[0])}/versions/${encodeURIComponent(route[1])}/tools/${encodeURIComponent(tool.name)}` : `${this.gatewayUrl()}/tools/${tool.name}`, timeoutMs: tool.name === 'run_command' ? 130000 : 150000 };
    });
  }
  pinExisting() { for (const bot of this.manager.list()) this.registry.registerActor(bot.id, bot.allowedTools); }
  capabilityOperation(id, action) {
    const prior = this.capabilityOperations.get(id) || Promise.resolve();
    const operation = prior.catch(() => {}).then(() => { if (this.closed) fail('Capability controller is closing', 503); return action(); });
    this.capabilityOperations.set(id, operation);
    return operation.finally(() => { if (this.capabilityOperations.get(id) === operation) this.capabilityOperations.delete(id); });
  }
  async activate(id, version) {
    const result = await this.capabilityOperation(id, async () => {
      const descriptor = await this.supervisor.descriptor?.(id, version);
      const retirement = this.store.get('capability-retirements', `${id}@${version}`);
      if (descriptor || retirement && !retirement.externallyManaged) {
        const observed = await this.supervisor.status(id, version);
        if (observed?.state !== 'ready') fail('Capability version is not running; deploy it before activation', 409);
      } else {
        const registered = this.registry.getVersion(id, version, { private: true });
        if (!registered) fail('Capability version is not registered', 404);
        await this.registry.register({ id, version, endpoint: registered.endpoint, token: registered.token });
      }
      this.pinExisting();
      const activated = this.registry.activate(id, version);
      if (retirement) this.store.remove('capability-retirements', `${id}@${version}`);
      return activated;
    });
    void this.tick(); return result;
  }
  async unload(id) {
    const result = await this.capabilityOperation(id, () => { this.pinExisting(); return this.registry.unload(id); });
    void this.tick(); return result;
  }
  async grant(botId, allowed) {
    if (!Array.isArray(allowed) || allowed.some(name => typeof name !== 'string')) fail('tools must be an explicit string array');
    const bot = this.manager.get(botId);
    this.registry.registerActor(botId, bot.allowedTools);
    const known = new Set([...this.registry.inventory().versions.flatMap(version => version.tools.map(tool => tool.name)), ...controlTools.map(tool => tool.name)]);
    if (allowed.some(name => !known.has(name))) fail('Cannot grant an unregistered tool');
    this.manager.store.save('bots', { id: botId, allowedTools: [...new Set(allowed)] });
    this.registry.propose(botId, allowed); void this.tick(); return { botId, tools: allowed };
  }
  permittedVersion(actor, id, version) {
    if (actor === 'controller' || this.registry.bindingsFor(actor)[id] === version) return true;
    const transition = this.store.get('switches', actor);
    return Boolean(pending(transition) && (transition.previousBindings?.[id] === version || transition.bindings?.[id] === version));
  }
  inventory() {
    return { ...this.registry.inventory(), switches: this.store.list('switches').map(({ tools, toolSnapshot, ...record }) => record) };
  }
  toolInventory({ id, botId, offset = 0, limit = 10 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) fail('Invalid inventory pagination');
    const inventory = this.inventory();
    const groups = {
      services: inventory.services.filter(item => !id || item.id === id),
      versions: inventory.versions.filter(item => !id || item.capabilityId === id).map(({ tools, unknownRequests, ...item }) => ({ ...item, tools: tools.map(tool => ({ name: tool.name, effect: tool.effect })), unknownRequestCount: unknownRequests?.length || 0, unknownRequests: unknownRequests?.slice(0, 10) || [] })),
      bindings: inventory.bindings.filter(item => !botId || item.id === botId).map(({ id, bindings, revision, allowedNames }) => ({ id, bindings, revision, allowedNames })),
      switches: inventory.switches.filter(item => (!botId || item.id === botId) && (!id || item.bindings?.[id] || item.previousBindings?.[id])).map(({ id, phase, bindings, previousBindings, error, failures, registryCommitted, completedAt }) => ({ id, phase, bindings, previousBindings, error, failures, registryCommitted, completedAt })),
    };
    const totals = Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.length]));
    return { ...Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.slice(offset, offset + limit)])), totals, offset, limit,
      nextOffset: Object.values(totals).some(count => count > offset + limit) ? offset + limit : null, schemasOmitted: true };
  }
  save(botId, patch) { return this.store.save('switches', { id: botId, ...patch }); }
  begin(bot, proposal) {
    return this.save(bot.id, { phase: 'preparing', proposalId: proposal.id, updateId: randomUUID(), revision: String(proposal.revision),
      bindings: proposal.bindings, previousBindings: proposal.previousBindings, definitions: proposal.tools, allowedNames: proposal.allowedNames,
      toolSnapshot: null, registryCommitted: false, failures: 0, nextAttemptAt: null, resumePhase: null, completedAt: null, error: null });
  }
  async snapshot(bot, transition) {
    if (transition.toolSnapshot) return transition;
    const config = await this.manager.config(bot.id), priorNames = new Set(config.bundledToolNames || bot.allowedTools || []);
    const custom = (config.tools || []).filter(tool => !priorNames.has(tool.name));
    const bundled = this.tools(bot, transition.definitions, transition.bindings, transition.allowedNames ?? bot.allowedTools)
      .map(tool => ({ ...tool, headers: { Authorization: `Bearer ${this.manager.store.get('bots', bot.id).capabilityToken}` } }));
    return this.save(bot.id, { toolSnapshot: { tools: [...bundled, ...custom], bundledToolNames: bundled.map(tool => tool.name) }, configuredToolNames: [...bundled, ...custom].map(tool => tool.name).filter(Boolean) });
  }
  backoff(botId, error) {
    const transition = this.store.get('switches', botId);
    if (!pending(transition) || ['failed', 'blocked'].includes(transition.phase)) return;
    const failures = (transition.failures || 0) + 1, blocked = failures >= this.maxRetries;
    this.save(botId, { failures, phase: blocked ? 'blocked' : transition.phase, resumePhase: blocked ? transition.phase : transition.resumePhase,
      nextAttemptAt: blocked ? null : new Date(this.clock() + Math.min(60000, this.retryBaseMs * 2 ** (failures - 1))).toISOString(),
      error: { code: error.code || 'CAPABILITY_SWITCH_UNAVAILABLE', message: error.message || String(error) } });
  }
  tick() {
    if (this.running) return this.tickPromise;
    if (this.closed) return Promise.resolve();
    this.running = true;
    this.tickPromise = (async () => {
      for (const listed of this.manager.list()) {
        if (this.closed) break;
        try { await this.advance(this.manager.get(listed.id)); }
        catch (error) { this.backoff(listed.id, error); try { this.emit('capability-switch-error', { botId: listed.id, error: error.message }); } catch {} }
      }
    })().finally(() => { this.running = false; });
    return this.tickPromise;
  }
  async status(botId, updateId) {
    try { return await this.manager.request(botId, `/capability-updates/${encodeURIComponent(updateId)}`); }
    catch (error) { if (error.status !== 404) throw error; return null; }
  }
  send(botId, path, body) { return this.manager.request(botId, path, { method: 'POST', body: JSON.stringify(body) }); }
  async retireSuperseded(bot, transition, proposal) {
    const identity = await this.manager.identity(bot.id);
    if (identity && identity.state !== 'ready') return null;
    if (identity) {
      const status = await this.status(bot.id, transition.updateId);
      if (status && ['preparing', 'ready'].includes(status.status)) await this.send(bot.id, `/capability-updates/${encodeURIComponent(transition.updateId)}/abort`, {});
      if (status?.status === 'committed') fail('Bot acknowledged a superseded proposal; explicit reconciliation is required', 409);
    }
    if (proposal) return this.begin(bot, proposal);
    this.save(bot.id, { phase: 'complete', completedAt: now(), supersededAt: now(), error: null });
    return null;
  }
  async offline(bot, transition) {
    const root = join(this.manager.dataRoot, 'capabilities', 'bot-management');
    if (!this.managementLock) { await mkdir(root, { recursive: true }); this.managementLock ||= new WorkspaceExecutionLock(root); }
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(15000)]);
    return this.managementLock.withLock(`capability-switch:${bot.id}`, async () => {
      // The management worker takes this same kernel lock before reading startup
      // config. An identity observed before this lock may already be obsolete.
      if (await this.manager.identity(bot.id)) return false;
      const api = await this.manager.botApi();
      return api.withBotDataLease(this.manager.directory(bot.id), async () => {
        const config = await this.manager.config(bot.id);
        let staged;
        try {
          staged = await loadConfiguredTools(transition.toolSnapshot.tools, { botId: bot.id, dataDir: this.manager.directory(bot.id), workspace: config.workspace, signal });
          const names = new Set([...coreTools({}, {}).map(tool => tool.name), 'read_resource', 'read_session_history']);
          for (const tool of staged.tools) { if (names.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`); names.add(tool.name); }
        } catch (error) {
          this.save(bot.id, { phase: 'failed', nextAttemptAt: null, error: { code: 'CAPABILITY_PREPARE_FAILED', message: error.message } });
          return true;
        } finally { await staged?.close(); }
        this.registry.commit(bot.id, transition.proposalId);
        transition = this.save(bot.id, { phase: 'committing', registryCommitted: true });
        await writePrivateJson(join(this.manager.directory(bot.id), 'config.json'), { ...config, ...transition.toolSnapshot,
          capabilityBindingRevision: transition.revision, capabilityUpdateId: transition.updateId });
        this.save(bot.id, { phase: 'complete', completedAt: now(), failures: 0, nextAttemptAt: null, error: null });
        return true;
      }, { botId: bot.id, purpose: 'capability-switch' });
    }, signal);
  }
  failedBot(bot, transition, status) {
    const failures = (transition.failures || 0) + 1;
    const interrupted = status.error?.code === 'CAPABILITY_UPDATE_INTERRUPTED';
    const retry = interrupted && failures < this.maxRetries;
    return this.save(bot.id, { phase: retry ? (transition.registryCommitted ? 'committing' : 'preparing') : 'failed', failures,
      ...(retry ? { updateId: randomUUID() } : {}), error: status.error || { message: 'Bot preparation failed' },
      nextAttemptAt: retry ? new Date(this.clock() + Math.min(60000, this.retryBaseMs * 2 ** (failures - 1))).toISOString() : null });
  }
  async advance(bot) {
    let transition = this.store.get('switches', bot.id);
    const proposal = this.registry.propose(bot.id, bot.allowedTools);
    if (!transition || transition.phase === 'complete') {
      if (!proposal) return;
      transition = this.begin(bot, proposal);
    }
    const actor = this.registry.inventory().bindings.find(value => value.id === bot.id);
    if (!transition.registryCommitted && actor?.lastProposalId === transition.proposalId) transition = this.save(bot.id, { registryCommitted: true, phase: transition.phase === 'preparing' ? 'committing' : transition.phase });
    if (!transition.registryCommitted && proposal?.id !== transition.proposalId) {
      transition = await this.retireSuperseded(bot, transition, proposal);
      if (!transition) return;
    }
    if (['failed', 'blocked'].includes(transition.phase) || (transition.nextAttemptAt && Date.parse(transition.nextAttemptAt) > this.clock())) return;
    transition = await this.snapshot(bot, transition);
    const identity = await this.manager.identity(bot.id);
    if (!identity) { await this.offline(bot, transition); return; }
    if (identity.state !== 'ready') return;
    let status = await this.status(bot.id, transition.updateId);
    if (!status) status = await this.send(bot.id, '/capability-updates/prepare', { id: transition.updateId, ...transition.toolSnapshot, bindingRevision: transition.revision, reason });
    if (status.status === 'failed') { this.failedBot(bot, transition, status); return; }
    if (status.status === 'preparing') return;
    if (status.status === 'ready') {
      try { this.registry.commit(bot.id, transition.proposalId); }
      catch (error) {
        if (error.code !== 'CAPABILITY_PROPOSAL_STALE') throw error;
        await this.send(bot.id, `/capability-updates/${encodeURIComponent(transition.updateId)}/abort`, {});
        this.save(bot.id, { phase: 'failed', error: { code: error.code, message: error.message } }); return;
      }
      transition = this.save(bot.id, { phase: 'committing', registryCommitted: true });
      status = await this.send(bot.id, `/capability-updates/${encodeURIComponent(transition.updateId)}/commit`, {});
    }
    if (status.status === 'committed') {
      this.registry.commit(bot.id, transition.proposalId);
      this.save(bot.id, { phase: 'complete', registryCommitted: true, completedAt: now(), failures: 0, nextAttemptAt: null, error: null });
    }
  }
  async retry(botId) {
    const bot = this.manager.get(botId), transition = this.store.get('switches', botId);
    if (!transition || !['failed', 'blocked'].includes(transition.phase)) fail('Only failed or blocked switches may be retried', 409);
    if (transition.phase === 'blocked') this.save(botId, { phase: transition.resumePhase || 'preparing', failures: 0, nextAttemptAt: null, error: null });
    else if (transition.registryCommitted) this.save(botId, { phase: 'committing', updateId: randomUUID(), failures: 0, nextAttemptAt: null, error: null });
    else {
      const proposal = this.registry.propose(botId, bot.allowedTools);
      if (proposal) this.begin(bot, proposal);
      else this.save(botId, { phase: 'complete', completedAt: now(), error: null });
    }
    void this.tick();
    return { botId, retryRequested: true };
  }
  async retire(id, version) {
    return this.capabilityOperation(id, async () => {
      const record = this.registry.inventory().versions.find(item => item.capabilityId === id && item.version === version);
      if (!record?.retirementReady) fail('Version still has bindings, active routes, requests or unknown results', 409);
      if (this.store.list('switches').some(item => pending(item) && (item.previousBindings?.[id] === version || item.bindings?.[id] === version))) fail('Bot commit acknowledgement is still pending', 409);
      const descriptor = await this.supervisor.descriptor?.(id, version);
      if (!descriptor) {
        this.store.save('capability-retirements', { id: `${id}@${version}`, capabilityId: id, version, state: 'routing-retired', externallyManaged: true, retiredAt: now() });
        return { id, version, externallyManaged: true, routingRetired: true, serviceStopped: false };
      }
      const status = await this.supervisor.status(id, version);
      if (status?.pendingWork || status?.activeRequests) fail('Version still has background work or active requests', 409);
      this.store.save('capability-retirements', { id: `${id}@${version}`, capabilityId: id, version, state: 'retiring' });
      const result = await this.supervisor.stop(id, version);
      this.store.save('capability-retirements', { id: `${id}@${version}`, state: 'stopped', retiredAt: now() });
      return result;
    });
  }
  reconcile({ requestId, outcome, evidence }, { actor = 'controller' } = {}) {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 512 || !['completed', 'failed'].includes(outcome) || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 16384) fail('Reconciliation requires requestId, a completed/failed outcome, and nonempty observed evidence');
    return this.store.transaction(() => {
      const previous = this.store.get('capability-reconciliations', requestId);
      if (previous) {
        if (previous.outcome !== outcome || previous.evidence !== evidence.trim()) fail('Request already has different reconciliation evidence', 409);
        return previous;
      }
      const request = this.registry.resolveRequest(requestId, { outcome });
      return this.store.save('capability-reconciliations', { id: requestId, requestId, outcome, evidence: evidence.trim(), actor,
        capabilityId: request.capabilityId, version: request.version, reconciledAt: now() });
    });
  }
  async call(name, args, context) {
    switch (name) {
      case 'capabilities_list': return this.toolInventory(args);
      case 'capabilities_register': return this.registry.register(args);
      case 'capabilities_deploy': if (!this.deploy) fail('Capability publisher is not configured', 503); return this.deploy(args);
      case 'capabilities_activate': return this.activate(args.id, args.version);
      case 'capabilities_unload': return this.unload(args.id);
      case 'capabilities_grant': return this.grant(args.botId, args.tools);
      case 'capabilities_retry': return this.retry(args.botId);
      case 'capabilities_reconcile': return this.reconcile(args, context);
      case 'capabilities_retire': return this.retire(args.id, args.version);
      default: fail('Unknown control tool', 404);
    }
  }
  async close() { this.closed = true; this.stopping.abort(new Error('Capability controller is closing')); await this.tickPromise; await Promise.allSettled([...this.capabilityOperations.values()]); }
}
