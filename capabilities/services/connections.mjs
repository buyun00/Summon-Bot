import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { idOf, keyOf, reject, user } from '../platform/contract.mjs';
import { workspaceGranted } from '../platform/workspace-access.mjs';
import { codexBridge } from '../connectors/codex.mjs';
import { protocolOf, sameBinding } from './connection-binding.mjs';
import { codexInput, connectionExecutable, executionWorkspace, prepareProcess } from './connection-launch.mjs';
import { canSupplyProcessArguments, connectionAllowed, connectionAuthorized, connectionRecords, executionRecords, plain, validateConnection } from './connection-records.mjs';
import { codexCredentials, inspectNative, redactNative } from './native-host.mjs';
import { nativeFileOperands } from './native-references.mjs';
import { visibleProbe } from './native-probe.mjs';
import { assertServiceConfig, credentialNames, mcpMethodUnsupported, mcpTasksUnsupported, serviceMethod, ServiceConnections } from './service-connection.mjs';
import { inputRecords, makeProcessGuard, operationRecords, SessionProcesses, settled } from './session-processes.mjs';

export { connectionRecords } from './connection-records.mjs';

const codexStatus = { completed: 'completed', interrupted: 'stopped', failed: 'failed' };
const nativeKind = kind => kind === 'cli' || kind === 'codex';
const stdioMcp = entry => entry.kind === 'mcp' && entry.config.transport === 'stdio';
const actorOf = context => context?.actor || context;
const callSession = (session, call) => ({ id: call.id, session_id: session.id, submitted_by: call.submitted_by });
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !value.includes('\0');
const retainsMethods = (before = [], after = [], field) => before.every(method =>
  after.some(next => next[field] === method[field] && isDeepStrictEqual(method, next)));
function bindingConfig(entry) {
  const { model, effort, credential_refs, headersEnv, env, tools, adapter, app_server_stdio, launch_arguments, detected_version, setup_key,
    initialized_for, methods, probe, ...binding } = entry.config;
  // Adapters can update how they call the same executable. Changing the vendor
  // protocol or the trusted interpreter changes what the connection authorizes.
  return { ...binding, ...(adapter ? { adapter: { connector: adapter.connector ?? null, runner: adapter.runner ?? null } } : {}),
    ...(!nativeKind(entry.kind) && Array.isArray(tools) ?
    { tools: tools.map(tool => {
      if (!plain(tool)) return tool;
      const { headersEnv, env, ...settings } = tool;
      return settings;
    }) } : {}) };
}

export class SummonConnections {
  constructor({ store, dataRoot, workspace, assertSessionAuthority, onEvent, onWorkEvent }) {
    if (!store || !dataRoot) throw new Error('Connection storage and data root are required');
    Object.assign(this, { store, dataRoot, workspace: resolve(workspace || dataRoot, workspace ? '.' : 'workspace'), assertSessionAuthority, onEvent, onWorkEvent });
    this.processes = new SessionProcesses({ store, dataRoot, clean: value => this.clean(value) });
    this.services = new ServiceConnections(this);
    this.active = new Map();
    this.locks = new Map();
  }

  clean(value, connections = this.store.list(connectionRecords)) {
    const secrets = [...new Set(connections.flatMap(credentialNames).map(name => process.env[name]).filter(Boolean))]
      .flatMap(value => {
        const authorization = value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
        return authorization ? [value, authorization[1]] : [value];
      }).sort((a, b) => b.length - a.length);
    const visit = value => typeof value === 'string' ? redactNative(value, secrets)
      : Array.isArray(value) ? value.map(visit) : plain(value)
        ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [redactNative(name, secrets),
          name === 'data' && ['image', 'audio'].includes(value.type) ? entry : visit(entry)]))
        : value;
    return visit(value);
  }

  get(id) { return this.store.get(connectionRecords, id); }
  current(session) { return this.store.get(executionRecords, session.id) || session; }

  serial(id, run) {
    if (this.locks.has(id)) reject('execution_busy', 'This Session is already accepting an input', 409);
    const task = Promise.resolve().then(run);
    this.locks.set(id, task);
    return task.finally(() => { if (this.locks.get(id) === task) this.locks.delete(id); });
  }

  available(entry, seen = new Set()) {
    if (!entry?.enabled || seen.has(entry.id)) return false;
    if (nativeKind(entry.kind) && (!existsSync(entry.config.file) || !existsSync(entry.config.canonical_file))) return false;
    const visited = new Set([...seen, entry.id]);
    return (entry.dependencies || []).every(id => {
      const dependency = this.get(id);
      return this.available(dependency, visited);
    });
  }

  authorized(entry, actor) { return connectionAuthorized(entry, actor, id => this.get(id)); }

  requireUsable(entry, actor, { runtime = true } = {}) {
    if (!this.authorized(entry, actor)) reject('connection_forbidden', 'The connection or a dependency is outside the caller’s grants', 403);
    if (runtime && !this.available(entry)) reject('connection_unavailable', 'The connection executable or a required resource is unavailable', 409);
    return entry;
  }

  requireAccess(entry, context) {
    const actor = actorOf(context);
    if (!connectionAllowed(entry, actor)) reject('connection_not_found', 'Connection is unavailable', 404);
    if (context?.allow && !context.allow(entry.id)) reject('connection_forbidden', 'Connection is unavailable in this execution context', 403);
    return actor;
  }

  summary(entry, available = entry.enabled ? undefined : false) {
    return { kind: 'connection', protocol: protocolOf(entry), id: entry.id, name: entry.name, description: entry.description,
      revision: entry.revision, binding_version: entry.binding_version ?? 1, enabled: entry.enabled,
      ...(available === undefined ? {} : { available }), version: entry.config.detected_version ?? entry.version };
  }

  find(context, query = '') {
    const term = String(query || '').trim().toLowerCase();
    const actor = actorOf(context);
    const matching = this.store.list(connectionRecords).filter(entry => [entry.id, entry.kind, entry.name, entry.description]
      .some(value => String(value || '').toLowerCase().includes(term)) && connectionAllowed(entry, actor) && (!context?.allow || context.allow(entry.id)));
    return this.clean(matching.map(entry => this.summary(entry)), []);
  }

  async read(id, context) {
    const entry = this.get(idOf(id, 'connection'));
    const actor = this.requireAccess(entry, context);
    const authorized = this.authorized(entry, actor);
    const available = !authorized ? false : nativeKind(entry.kind) ? this.available(entry) : undefined;
    const summary = this.clean(this.summary(entry, available), []);
    const nativeLocation = { file: entry.config.file, canonical_file: entry.config.canonical_file, workspace_root: entry.config.workspace_root,
      ...(authorized && entry.config.probe ? { probe: visibleProbe(entry.config.probe) } : {}) };
    if (entry.kind === 'codex') return this.clean({ ...summary, ...nativeLocation, input: { text: 'string', model: 'optional exact model id', effort: 'optional reasoning effort' },
      operations: ['reply', 'steer', 'next', 'stop'], ...(entry.config.model ? { model: entry.config.model, effort: entry.config.effort } : {}) }, [entry]);
    if (entry.kind === 'cli') {
      if (entry.config.ssh) {
        const { host, port = 22, user, operations } = entry.config.ssh;
        return this.clean({ ...summary, ...nativeLocation, remote: { host, port, user },
          input: { method: 'configured SSH method', parameters: 'optional host-approved method values' },
          methods: operations.map(({ id, name, description, parameters }) => ({ id, name, description, parameters })), direct_arguments: false }, [entry]);
      }
      if (entry.config.adapter) return this.clean({ ...summary, ...nativeLocation, input: { text: 'string' },
        operations: entry.config.adapter.resume ? ['next', 'stop'] : ['stop'] }, [entry]);
      const methods = (entry.config.methods || []).map(({ id, name, description, args, effect, file_args, keep_input }) =>
        ({ id, name, description, args, effect, file_args, keep_input }));
      return this.clean({ ...summary, ...nativeLocation, input: { method: 'optional configured method', parameters: 'optional method parameters',
        args: 'argument strings', stdin: 'optional text', keep_input: 'optional boolean', file_args: 'optional file argument roles' },
      direct_arguments: canSupplyProcessArguments(entry, actor),
      file_operands: authorized ? await nativeFileOperands() : [], methods }, [entry]);
    }
    if (entry.kind === 'http') return this.clean({ ...summary, methods: await this.services.methods(entry, actor) }, []);
    if (!authorized) return summary;
    const authorizeDiscovery = () => {
      this.assertRunning(context?.signal);
      const session = context?.session ? this.store.get(executionRecords, context.session.id) : undefined;
      const current = this.get(id);
      this.requireAccess(current, { ...context, actor, session });
      if (context?.session && (!session || session.authority_revoked))
        reject('session_authority_revoked', 'The Session no longer has its assigned execution authority', 403);
      if (session) {
        if (session.control.state !== 'active') reject('execution_paused', 'Execution is paused', 409);
        this.assertSessionAuthority?.(session, { checkWorkspacePath: true });
      }
      this.requireUsable(current, actor);
      if (!isDeepStrictEqual(current.config, entry.config))
        reject('connection_binding_changed', 'The service connection changed before method discovery', 409);
      return session;
    };
    const session = authorizeDiscovery();
    let cwd = this.workspace;
    if (stdioMcp(entry)) {
      try {
        cwd = await this.serviceWorkingDirectory(entry, session, { fromSession: Boolean(session) });
      } catch (error) {
        if (error.code !== 'scoped_process_unsupported') throw error;
        return { ...summary, status: 'unsupported', code: error.code, error: this.clean(error.message) };
      }
      authorizeDiscovery();
    }
    const methods = await this.services.methods(entry, actor, cwd, context?.signal);
    authorizeDiscovery();
    return this.clean({ ...summary, available: true, methods }, []);
  }

  settings(context) {
    if (actorOf(context)?.kind !== 'user') reject('connection_forbidden', 'Connection settings require the host user', 403);
    const entries = this.store.list(connectionRecords);
    return this.clean(entries.map(entry => ({ ...this.summary(entry), allowed_bot_ids: ['*'],
      dependencies: entry.dependencies, maintainer_bot_id: entry.maintainer_bot_id ?? null })), []);
  }

  async configure(input, context, onSave) {
    if (actorOf(context)?.kind !== 'user') reject('connection_forbidden', 'Connection settings require the host user', 403);
    if (!plain(input) || Object.keys(input).some(key => !['id', 'name', 'description', 'kind', 'config', 'config_patch', 'revision',
      'enabled', 'allowed_bot_ids', 'dependencies', 'maintainer_bot_id'].includes(key)))
      reject('invalid_connection', 'Invalid connection settings');
    const id = idOf(input.id, 'connection');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id) || id === 'pi') reject('invalid_connection', 'Invalid managed connection identity');
    const previous = this.get(id);
    if (previous && input.revision !== previous.revision) reject('revision_conflict', 'Connection settings changed', 409, { revision: previous.revision });
    const { revision, config_patch, ...submitted } = input;
    if (config_patch !== undefined) {
      if (!previous || !plain(config_patch) || Object.hasOwn(submitted, 'config'))
        reject('invalid_connection', 'Supply a config_patch object for an existing connection without replacing config');
      submitted.config = { ...previous.config, ...config_patch };
    }
    const entry = { ...previous, ...submitted, id, enabled: submitted.enabled ?? previous?.enabled ?? true,
      allowed_bot_ids: ['*'] };
    if (!previous && entry.kind === 'cli' && entry.config && !entry.config.ssh && !entry.config.adapter &&
        !entry.config.methods?.length && entry.config.allow_arguments === undefined)
      entry.config = { ...entry.config, allow_arguments: true };
    validateConnection(entry);
    if (typeof entry.name !== 'string' || !entry.name.trim()) reject('invalid_connection', 'Connection name is required');
    if (previous && previous.kind !== entry.kind) reject('connection_binding_conflict', 'Use a new id for another connection protocol', 409);
    const configChanged = !previous || !isDeepStrictEqual(entry.config, previous.config);
    if (!nativeKind(entry.kind) && configChanged) assertServiceConfig(entry);
    const changed = previous && (!isDeepStrictEqual(bindingConfig(previous), bindingConfig(entry)) ||
      !retainsMethods(previous.config.methods, entry.config.methods, 'id'));
    const record = this.store.transaction(() => {
      if (this.get(id)?.revision !== previous?.revision) reject('revision_conflict', 'Connection settings changed', 409);
      context.beforeConnectionSave?.(entry, previous);
      if (!previous) {
        const matches = this.store.list(connectionRecords).filter(item => sameBinding(item, entry));
        const visible = matches.filter(item => !context.canSeeBinding || context.canSeeBinding(item));
        if (matches.length > 1) reject('connection_binding_ambiguous', 'Choose an existing connection for this binding',
          409, { candidates: this.clean(visible.map(item => this.summary(item)), []) });
        if (matches.length) {
          if (!visible.length) reject('connection_access_required', 'This binding is registered and requires a connection grant', 403);
          onSave?.({ ...this.clean(this.summary(visible[0]), []), reused: true });
          return visible[0];
        }
      }
      if (previous && isDeepStrictEqual(entry, previous)) {
        onSave?.(this.clean(this.summary(previous), []));
        return previous;
      }
      const saved = this.store.save(connectionRecords, { ...entry, revision: (previous?.revision || 0) + 1,
        binding_version: (previous?.binding_version ?? 1) + Number(Boolean(changed)) });
      onSave?.(this.clean(this.summary(saved), []));
      return saved;
    });
    if (record.kind === 'mcp' && previous && (!record.enabled || configChanged))
      void this.services.disconnect(id);
    return { ...this.clean(this.summary(record), []), ...(record.id !== id ? { reused: true } : {}) };
  }

  entryFor(session, call, options) {
    const id = typeof session.engine === 'string' ? session.engine : session.engine?.id;
    const entry = this.get(session.connection_id || id);
    if (!entry) reject('connection_forbidden', 'The Session connection is unavailable', 403);
    if (call) this.requireUsable(entry, call.submitted_by, { runtime: false });
    if (session.connection_binding_version !== undefined && session.connection_binding_version !== (entry.binding_version ?? 1))
      reject('connection_binding_changed', 'The original Session’s connection settings changed', 409);
    return this.requireUsable(entry, session.execution_actor, options);
  }

  checkServiceMethod(entry, current, method) {
    if (!current || (current.binding_version ?? 1) !== (entry.binding_version ?? 1) ||
        !isDeepStrictEqual(serviceMethod(current, method), serviceMethod(entry, method)))
      reject('connection_binding_changed', 'The selected service method changed before submission', 409);
  }

  requireObservation(entry, session, operation, method) {
    this.assertRunning();
    const live = this.store.get(executionRecords, session.id);
    if (!live || operation.revoked_at || this.locks.has(session.id))
      reject('observation_unavailable', 'The original Session is unavailable for an external status query', 409);
    const current = this.entryFor(live);
    if (current.id !== operation.connection_id || !this.locallyAuthorized(live, operation, current))
      reject('session_authority_revoked', 'The original Session no longer grants this external status query', 403);
    this.assertSessionAuthority?.(live, { checkWorkspacePath: true });
    if (method !== undefined) this.checkServiceMethod(entry, current, method);
    return current;
  }

  operations(session) {
    return this.store.list(operationRecords).filter(operation => operation.session_id === session.id)
      .sort((left, right) => (left.input_revision ?? 0) - (right.input_revision ?? 0));
  }

  saveOperation(operation, facts) { return this.store.save(operationRecords, { id: operation.id, ...facts }); }

  async startProcess(entry, session, call, input, beforeSubmit, signal, prior = null) {
    const guard = makeProcessGuard(session, entry, call);
    const launch = await prepareProcess({ host: this, entry, session, call, input, prior, guard });
    if (prior && launch.cwd !== prior.cwd)
      reject('workspace_binding_changed', 'The native session’s original working directory changed', 409);
    const operation = this.store.save(operationRecords, { ...callSession(session, call), protocol: launch.protocol,
      instance_id: randomUUID(), launch_call_id: call.id, cwd: launch.cwd, connection_id: entry.id,
      method: launch.method, connection_version: this.summary(entry).version,
      connection_binding_version: entry.binding_version ?? 1, execution_actor: session.execution_actor,
      app_server_launch: launch.appServerLaunch,
      thread_id: prior?.thread_id, requested_native_id: launch.managedAdapter ? launch.sessionId ?? undefined : undefined,
      binding: prior?.binding, status: 'prepared',
      ...(session.group_work ? { work_program: entry.config.canonical_file } : {}),
      input_revision: (prior?.input_revision ?? session.input_revision ?? 0) + 1 });
    const started = await this.processes.launch(operation, launch, () => {
      this.assertRunning(signal);
      this.entryFor(this.current(session), call);
      return beforeSubmit();
    });
    return this.operationFacts(started, session);
  }

  assertRunning(signal) {
    signal?.throwIfAborted();
    if (this.closing) reject('connection_closing', 'The gateway has stopped accepting external calls', 503);
  }

  open({ session, call, input, beforeSubmit, signal }) {
    return this.serial(session.id, async () => {
      this.assertRunning(signal);
      const original = this.store.get(operationRecords, call.id);
      if (original) return this.operationFacts(await this.refresh(original, session), session);
      const entry = this.entryFor(session, call);
      if (nativeKind(entry.kind)) return this.startProcess(entry, session, call, input, beforeSubmit, signal);
      return this.startService(entry, session, call, input, beforeSubmit, signal);
    });
  }

  async serviceWorkingDirectory(entry, session = {}, options) {
    const workspace = await executionWorkspace(session, entry, this, options);
    if (stdioMcp(entry) && (workspace.isReadOnly || workspace.hasFileScope))
      reject('scoped_process_unsupported', 'This MCP stdio process cannot enforce the Session’s file restrictions', 403);
    if (entry.config.canonical_command && !samePath(workspace.cwd, entry.config.workspace_root))
      reject('workspace_forbidden', 'Use the registered MCP stdio launch directory', 403);
    return workspace.cwd;
  }

  async startService(entry, session, call, input, beforeSubmit, signal) {
    const operation = this.store.save(operationRecords, { ...callSession(session, call), protocol: 'service',
      launch_call_id: call.id, connection_id: entry.id, connection_version: this.summary(entry).version, execution_actor: session.execution_actor,
      connection_binding_version: entry.binding_version ?? 1, status: 'prepared', input_revision: (session.input_revision || 0) + 1 });
    let started = false;
    try {
      const cwd = stdioMcp(entry) ? await this.serviceWorkingDirectory(entry, session) : this.workspace;
      const authorize = () => {
        this.assertRunning(signal);
        const live = this.store.get(executionRecords, session.id);
        if (!live || live.authority_revoked || live.control.state !== 'active')
          reject('session_authority_revoked', 'The Session no longer has active execution authority', 403);
        const current = this.entryFor(live, call);
        this.assertSessionAuthority?.(live, { checkWorkspacePath: true });
        this.checkServiceMethod(entry, current, input?.method);
      };
      authorize();
      const abortController = new AbortController();
      const combinedSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;
      this.active.set(operation.id, abortController);
      const result = await this.services.invoke(entry, session.execution_actor, cwd, input, call.id, async () => {
        authorize();
        await beforeSubmit();
        authorize();
        this.saveOperation(operation, { cwd, method: input.method, status: 'submitted', submitted_at: new Date().toISOString() });
        started = true;
      }, combinedSignal, { onProgress: progress => {
        const current = this.store.get(operationRecords, operation.id);
        const position = (current?.progress_position || 0) + 1;
        const id = keyOf(operation.id, position);
        try {
          this.store.transaction(() => {
            this.store.save('session-service-events', { id, operation_id: operation.id, position, progress });
            this.saveOperation(operation, { progress_position: position });
            if (session.group_work && started) this.onWorkEvent?.(session.id, operation.id, ['progress', position], {
              phase: 'progress', method: input.method, cwd, progress,
            });
          });
        } catch (error) { console.error('Could not persist MCP progress', this.clean(error.message)); }
      } });
      const saved = this.saveOperation(operation, this.services.facts(entry, result));
      return this.operationFacts(saved, session);
    } catch (error) {
      const interruptedByUser = abortController.signal.aborted || error.code === 'interrupted_by_user';
      if (interruptedByUser) {
        const now = new Date().toISOString();
        const saved = this.saveOperation(operation, {
          status: 'stopped',
          runtime_ended: true,
          finished_at: now,
          code: 'interrupted_by_user',
          error: started ? 'Interrupted by user; remote side effect outcome is unknown' : 'Interrupted by user before submission',
          remote_outcome: started ? 'unknown_may_still_be_running' : 'confirmed_stopped',
          ...(started ? { detached_at: now, detached_reason: 'interrupted_by_user' } : {}),
        });
        return this.operationFacts(saved, session);
      }
      const unsupported = !started && [mcpTasksUnsupported, mcpMethodUnsupported, 'scoped_process_unsupported'].includes(error.code);
      const unknown = started && (error.outcomeUnknown || signal?.aborted || error.name === 'AbortError');
      const http_status = started && entry.kind === 'http' && Number.isInteger(error.status) ? error.status : undefined;
      const code = (!started || http_status) && typeof error.code === 'string' ? this.clean(error.code) : undefined;
      const saved = this.saveOperation(operation, { status: unsupported ? 'unsupported' : unknown ? 'unknown' : started ? 'failed' : 'not_submitted',
        runtime_ended: !unknown, error: this.clean(error.message), code, http_status });
      return this.operationFacts(saved, session);
    } finally { this.active.delete(operation.id); }
  }

  async refresh(operation, session, { reconcile = false } = {}) {
    if (operation.status === 'prepared' && !this.locks.has(operation.session_id)) {
      return this.saveOperation(operation, { status: 'not_submitted', runtime_ended: true, error: 'The original call ended before submission' });
    }
    if (operation.protocol === 'service') {
      if (operation.status === 'submitted' && !operation.service_accepted && !this.active.has(operation.id))
        return this.saveOperation(operation, { status: 'unknown', error: 'The original service receipt was not saved before the gateway stopped' });
      const entry = this.get(operation.connection_id);
      const method = entry?.config.lifecycle?.status_method;
      if (!method || !operation.operation_id || settled(operation.status) && operation.status !== 'unknown') return operation;
      try { this.requireObservation(entry, session, operation, method); }
      catch { return operation; }
      return this.services.refresh(operation, entry, session);
    }
    const current = await this.processes.refresh(operation);
    if (reconcile && current.protocol === 'codex' && current.status === 'unknown' && current.thread_id) {
      return this.reconcileCodex(current, session);
    }
    return current;
  }

  async reconcileCodex(operation, session) {
    if (Date.now() - (operation.last_lookup_at ? Date.parse(operation.last_lookup_at) : 0) < 15_000) return operation;
    let entry;
    try { entry = this.requireObservation(this.get(operation.connection_id), session, operation); }
    catch { return operation; }
    const attempt = this.saveOperation(operation, { last_lookup_at: new Date().toISOString() });
    try {
      const file = await connectionExecutable(entry, operation.cwd, this.dataRoot, session.path_policy);
      const current = this.requireObservation(entry, session, operation);
      if (!isDeepStrictEqual(current.config.credential_refs, entry.config.credential_refs)) return attempt;
      const credentials = codexCredentials(entry.config);
      const originalLaunch = operation.app_server_launch;
      const outcome = await inspectNative(process.execPath, [codexBridge, file, 'history', operation.thread_id,
        operation.turn_id || '', operation.original_operation_id || operation.id,
        originalLaunch?.mode ?? entry.config.app_server_stdio ?? 'flag', ...(originalLaunch?.args || [])],
      operation.cwd, { timeoutMs: 15_000, codex: true, ...credentials });
      if (outcome.exitCode !== 0) return attempt;
      const history = JSON.parse(outcome.stdout);
      if (history.threadId !== operation.thread_id || (operation.turn_id && operation.turn_id !== history.turnId)) return attempt;
      const latest = this.store.get(operationRecords, operation.id);
      if (!latest || this.locks.has(session.id) || latest.status !== 'unknown' || latest.updatedAt !== attempt.updatedAt)
        return latest || attempt;
      const status = codexStatus[history.turnStatus];
      const binding = { model: operation.binding?.model || history.model, effort: operation.binding?.effort || history.effort };
      if (!status) return this.saveOperation(operation, { binding });
      return this.saveOperation(operation, { status, binding, turn_id: history.turnId, recovered_at: new Date().toISOString(), runtime_ended: true,
        result: history.text ? { text: history.text, confirmed: status === 'completed' } : operation.result, error: history.error });
    } catch { return attempt; }
  }

  targets(operation, session, ignoreCallId) {
    const entry = this.get(operation.connection_id);
    if (session.control.state !== 'active' || session.authority_revoked || !this.authorized(entry, session.execution_actor) || operation.revoked_at ||
        operation.connection_binding_version !== undefined && operation.connection_binding_version !== (entry.binding_version ?? 1)) return [];
    if (settled(operation.status)) {
      const resumable = operation.protocol === 'codex' ? operation.thread_id && !operation.binding_rejected :
        entry.config.adapter?.resume && (operation.original_native_id || operation.requested_native_id) &&
        ['completed', 'failed', 'stopped'].includes(operation.status);
      if (resumable && operation.status !== 'unknown' && operation.runtime_ended && session.workspace?.path && session.workspace_ref)
        return [{ input_target: { kind: 'idle_input', input_revision: operation.input_revision }, kinds: ['next'] }];
      return [];
    }
    const entries = [];
    const add = (input_target, ...kinds) => entries.push({ input_target, kinds });
    const answered = requestId => this.store.list(inputRecords).some(item => item.id !== ignoreCallId && item.status !== 'prepared' &&
      item.operation_id === operation.id &&
      (item.target?.request_id ?? item.original_request_id) === requestId &&
      !['not_submitted', 'rejected'].includes(item.receipt?.status));
    if (!['running', 'awaiting-input', 'needs_input'].includes(operation.status)) return entries;
    if (operation.protocol === 'service') {
      const config = entry.config.lifecycle;
      if (!config || !operation.operation_id) return entries;
      const target = { kind: 'service_call', call_id: operation.id, operation_id: String(operation.operation_id) };
      if (operation.request_id && config.reply_method && !answered(operation.request_id)) add({ ...target, request_id: operation.request_id }, 'reply');
      if (config.steer_method) add(target, 'steer');
      return entries;
    }
    const target = operation.protocol === 'codex' && operation.turn_id
      ? { kind: 'codex_turn', turn_id: operation.turn_id }
      : operation.protocol !== 'codex' ? { kind: 'cli_process', instance_id: operation.instance_id, launch_call_id: operation.launch_call_id } : null;
    if (target && operation.stdin_open) {
      add(target, 'steer');
      for (const request of operation.pending || []) if (!answered(request.id)) add({ ...target, request_id: request.id }, 'reply');
    }
    return entries;
  }

  operationFacts(operation, session) {
    const status = operation.status === 'awaiting-input' ? 'needs_input' : operation.status === 'starting' ? 'submitted' : operation.status;
    const native = operation.protocol === 'codex' ? { protocol: 'codex', thread_id: operation.thread_id, turn_id: operation.turn_id,
      model: operation.binding?.model, effort: operation.binding?.effort, reroute: operation.reroute } : operation.protocol === 'service' ?
      { protocol: 'service', call_id: operation.id, ...(operation.operation_id ? { operation_id: String(operation.operation_id) } : {}) } :
      { protocol: 'cli', instance_id: operation.instance_id, launch_call_id: operation.launch_call_id, pid: operation.child_pid,
        operation_id: operation.original_native_id, requested_operation_id: operation.requested_native_id };
    const pending = operation.pending?.length ? operation.pending : undefined;
    const facts = this.clean({ status, session_status: status, native, input_revision: operation.input_revision, safe_to_disconnect: this.safeToDisconnect(operation),
      ...(operation.result ? { output: operation.result } : operation.error ?
        { output: { error: operation.error, code: operation.code, http_status: operation.http_status } } : {}),
      ...(operation.error ? { error: operation.error } : {}), ...(operation.code ? { code: operation.code } : {}) });
    return { ...facts, input_targets: this.targets(operation, this.current(session)), pending_input: pending,
      ...(pending && !facts.output ? { output: { requests: pending } } : {}) };
  }

  observationKey(operation, status) {
    const inputIssue = ['native_request_unsupported', 'native_event_unsupported'].includes(operation.code) ? [operation.code] : [];
    const position = keyOf(status, operation.thread_id, operation.turn_id, operation.operation_id ?? operation.original_native_id, operation.request_id, ...inputIssue,
      ...(operation.pending || []).map(item => item.id));
    return status === 'unknown' && this.safeToDisconnect(operation) ? keyOf(position, 'runtime_ended') : position;
  }

  async inspect(session, { cursor, limit, stream = 'stdout' } = {}) {
    const operations = this.operations(session);
    const operation = operations.findLast(item => item.status !== 'prepared') || operations.at(-1);
    if (!operation) return {};
    const latest = await this.refresh(operation, session, { reconcile: !this.locks.has(session.id) });
    const facts = this.operationFacts(latest, session);
    const members = operations.map(item => ({ call_id: item.id, status: item.status, instance_id: item.instance_id, turn_id: item.turn_id,
      ...(item.instance_id ? { cursors: Object.fromEntries(['stdout', 'stderr', 'events'].map(stream => [stream, keyOf(item.id, 0, stream)])) } : {}) }));
    const inputPositions = this.store.list(inputRecords).filter(item => operations.some(operation => operation.id === item.operation_id))
      .map(item => ({ call_id: item.id, operation_call_id: item.operation_id, kind: item.kind,
        target: item.target, status: item.receipt?.status || item.status, receipt: item.receipt }));
    if (!latest.instance_id) {
      const events = this.store.list('session-service-events').filter(item => item.operation_id === latest.id);
      const from = cursor ? events.findIndex(item => item.id === cursor) + 1 : 0;
      if (cursor && !from) reject('invalid_cursor', 'Output cursor is unavailable', 409);
      const output_events = events.slice(from, from + (limit || 30));
      return { ...facts, operations: members, input_receipts: this.clean(inputPositions), output_events,
        next_cursor: output_events.at(-1)?.id || cursor || null };
    }
    let offset = 0, selected = latest;
    if (cursor) {
      let parsed;
      try { parsed = JSON.parse(cursor); } catch { reject('invalid_cursor', 'Invalid output cursor'); }
      selected = operations.find(item => item.id === parsed?.[0]);
      if (!selected?.instance_id || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) reject('invalid_cursor', 'Output cursor is unavailable', 409);
      offset = parsed[1];
      stream = parsed[2] || stream;
    }
    const out = await this.processes.output(selected, { offset, stream, limit: limit === undefined ? 16_384 : Math.max(1024, Math.min(limit * 1024, 65_536)) });
    return { ...facts, operations: members, input_receipts: this.clean(inputPositions), output_page: this.clean(out), output_call_id: selected.id,
      next_cursor: keyOf(selected.id, out.next_offset, stream) };
  }

  input({ session, call, kind, input_target, input, beforeSubmit, signal }) {
    return this.serial(session.id, async () => {
      this.assertRunning(signal);
      const entry = this.entryFor(this.current(session), call, { runtime: false });
      const previousLaunch = this.store.get(operationRecords, call.id);
      if (previousLaunch) return this.operationFacts(await this.refresh(previousLaunch, session), session);
      const prior = this.store.get(inputRecords, call.id);
      if (prior) return this.commandFacts(prior, this.store.get(operationRecords, prior.operation_id), session);
      let operation = this.operations(session).at(-1);
      if (!operation) reject('input_target_expired', 'There is no original execution', 409);
      operation = await this.refresh(operation, session, { reconcile: false });
      this.assertTarget(operation, session, kind, input_target);
      const check = async () => {
        this.assertRunning(signal);
        const current = this.current(session);
        const connection = this.entryFor(current, call, { runtime: kind === 'next' || operation.protocol === 'service' });
        if ((connection.binding_version ?? 1) !== (entry.binding_version ?? 1))
          reject('connection_binding_changed', 'The original connection changed before input submission', 409);
        const fresh = await this.refresh(operation, current);
        this.assertTarget(fresh, current, kind, input_target, call.id);
        await beforeSubmit();
      };
      if (kind === 'next') {
        this.requireUsable(entry, session.execution_actor);
        return this.startProcess(entry, session, call, input, check, signal, operation);
      }
      if (operation.protocol === 'service') {
        this.assertSessionAuthority?.(this.current(session), { checkWorkspacePath: true });
        return this.stepService(entry, session, operation, call, kind, input_target, input, check, signal);
      }
      const value = operation.protocol === 'codex' && kind === 'steer' ? codexInput(input, {}, operation.binding).text : input;
      if (!text(value)) reject('invalid_input', 'Input must contain 1–32768 characters without NUL');
      const pending = (operation.pending || []).find(request => request.id === input_target.request_id);
      if (pending?.choices?.length && !pending.choices.some(choice => choice.id === value))
        reject('invalid_choice', 'Select an actual value from the native request', 409);
      if (pending?.kind === 'approval' && pending.choices?.some(choice => choice.id === value && !['decline', 'cancel'].includes(value)) &&
          call.submitted_by.kind !== 'user') reject('approval_requires_user', 'The native protocol requires the user’s response for this approval', 403);
      const receipt = await this.processes.command(operation, call, kind, input_target, value, check, makeProcessGuard(session, entry, call));
      return this.commandFacts(receipt, operation, session);
    });
  }

  assertTarget(operation, session, kind, target, ignoreCallId) {
    if (!this.targets(operation, session, ignoreCallId).some(item => item.kinds.includes(kind) && isDeepStrictEqual(item.input_target, target)))
      reject('input_target_expired', 'The original native input is closed, busy, or no longer current', 409);
  }

  async stepService(entry, session, operation, call, kind, target, input, beforeSubmit, signal) {
    const method = entry.config.lifecycle?.[`${kind}_method`];
    if (!method) return { status: 'unsupported', session_status: operation.status };
    const prior = this.store.get(inputRecords, call.id);
    if (prior) return this.commandFacts(prior, operation, session);
    if (target?.request_id && this.store.list(inputRecords).some(row => row.operation_id === operation.id && row.target?.request_id === target.request_id &&
        !['rejected', 'not_submitted'].includes(row.receipt?.status))) reject('request_already_answered', 'The service request already has an answer', 409);
    this.store.save(inputRecords, { id: call.id, operation_id: operation.id, kind, target, status: 'prepared' });
    let submitted = false, response;
    try {
      response = await this.services.step(entry, session, operation, method, input, call.id, async () => {
        this.checkServiceMethod(entry, this.get(entry.id), method);
        await beforeSubmit();
        signal?.throwIfAborted();
        this.checkServiceMethod(entry, this.get(entry.id), method);
        this.store.save(inputRecords, { id: call.id, status: 'submitted' });
        submitted = true;
      }, signal, kind);
    } catch (error) {
      const receipt = { status: !submitted ? 'not_submitted' : error.outcomeUnknown || signal?.aborted ? 'unknown' : 'rejected',
        error: this.clean(error.message), ...(typeof error.code === 'string' ? { code: error.code } : {}) };
      return this.commandFacts(this.store.save(inputRecords, { id: call.id, receipt }), operation, session);
    }
    const { confirmed_operation_id, ...result } = response;
    const receipt = { status: result.status === 'unknown' ? 'unknown' :
      result.rejected ? 'rejected' : result.service_accepted ? 'acknowledged' : 'accepted', result: result.result };
    const [actual, saved] = this.store.transaction(() => [result.rejected ? operation : this.saveOperation(operation, result),
      this.store.save(inputRecords, { id: call.id, receipt, confirmed_operation_id })]);
    return this.commandFacts(saved, actual, session);
  }

  commandFacts(record, operation, session) {
    const receipt = record.receipt;
    const status = ['accepted', 'acknowledged', 'delivered'].includes(receipt?.status) ? 'completed' :
      receipt?.status === 'rejected' ? 'failed' : ['not_submitted', 'unknown', 'completed'].includes(receipt?.status) ? receipt.status : 'submitted';
    const facts = this.operationFacts(operation, session);
    const confirmed = operation.session_id === session.id && this.confirmedInput(record, operation);
    return { ...facts, status, session_status: facts.status, output: this.clean(receipt), input_status: receipt?.status || record.status,
      ...(confirmed ? { confirmed_input: confirmed } : {}) };
  }

  confirmedInput(record, operation) {
    const { kind, receipt, target } = record;
    if (record.migrated || record.suppressed || record.operation_id !== operation.id || !receipt || !target ||
        !['submitted', 'writing'].includes(record.status) || !['steer', 'reply'].includes(kind)) return;
    const accepted = receipt.status === 'accepted' && receipt.inputId === record.id && receipt.layer === operation.protocol;
    const codex = operation.protocol === 'codex' && kind === 'steer' && target.kind === 'codex_turn' &&
      accepted && operation.turn_id && receipt.turnId === operation.turn_id && target.turn_id === operation.turn_id;
    const cli = operation.protocol === 'summon-jsonl' && target.kind === 'cli_process' && accepted && record.native_acknowledged === true &&
      target.instance_id === operation.instance_id && target.launch_call_id === operation.launch_call_id;
    const service = operation.protocol === 'service' && target.kind === 'service_call' && ['accepted', 'acknowledged'].includes(receipt.status) &&
      record.confirmed_operation_id && target.call_id === operation.id && target.operation_id === record.confirmed_operation_id &&
      target.operation_id === String(operation.operation_id);
    if (codex || cli || service) return { operation_call_id: operation.id, input_target: target };
  }

  async stop({ session, call }) {
    const operation = this.operations(session).at(-1);
    if (!operation) return { status: 'stopped' };
    return this.stopOperation(await this.refresh(operation, session), session, call);
  }

  async stopOperation(operation, session, call) {
    const now = new Date().toISOString();
    const markStopRequested = patch => this.saveOperation(operation, { stop_requested_at: operation.stop_requested_at || now, ...patch });
    if (operation.runtime_ended && operation.status !== 'unknown') {
      return { status: 'stopped', remote_outcome: 'confirmed_stopped' };
    }
    if (operation.status === 'prepared') {
      markStopRequested({ status: 'not_submitted', runtime_ended: true, finished_at: now });
      return { status: 'stopped', remote_outcome: 'confirmed_stopped' };
    }
    if (operation.status === 'not_submitted') return { status: 'stopped', remote_outcome: 'confirmed_stopped' };
    if (operation.protocol === 'service') {
      const controller = this.active.get(operation.id);
      if (controller && typeof controller.abort === 'function') {
        controller.abort(Object.assign(new Error('Interrupted by user'), { code: 'interrupted_by_user' }));
      }
      const entry = this.get(operation.connection_id);
      if (entry?.config.lifecycle?.stop_method && operation.operation_id &&
          operation.session_id === session.id &&
          operation.connection_binding_version === (entry.binding_version ?? 1)) {
        const stopCall = { ...call, id: keyOf('stop', session.id, call.id, operation.id) };
        const result = await this.stepService(entry, session, operation, stopCall, 'stop', undefined, undefined, () => {});
        const confirmed = ['stopped', 'completed', 'failed'].includes(result.session_status);
        if (confirmed) {
          markStopRequested({ remote_outcome: 'confirmed_stopped', runtime_ended: true });
          return { status: 'stopped', remote_outcome: 'confirmed_stopped', ...(result.output?.error ? { error: result.output.error } : {}) };
        }
      }
      markStopRequested({
        detached_at: operation.detached_at || now,
        detached_reason: 'interrupted_by_user',
        remote_outcome: 'unknown_may_still_be_running',
      });
      return { status: 'detached', remote_outcome: 'unknown_may_still_be_running' };
    }
    const partial_snapshot = await this.processes.partialSnapshot(operation);
    if (operation.status === 'unknown') {
      if (!this.processes.isAlive(operation)) {
        markStopRequested({ runtime_ended: true, finished_at: operation.finished_at || now, remote_outcome: 'confirmed_stopped',
          ...(partial_snapshot ? { partial_snapshot } : {}) });
        return { status: 'stopped', remote_outcome: 'confirmed_stopped', ...(partial_snapshot ? { partial_snapshot } : {}) };
      }
      const killed = await this.processes.forceKill(operation);
      markStopRequested({
        detached_at: killed ? null : (operation.detached_at || now),
        detached_reason: killed ? null : 'interrupted_by_user',
        runtime_ended: killed,
        ...(killed ? { status: 'stopped', finished_at: now } : {}),
        remote_outcome: killed ? 'confirmed_stopped' : 'unknown_may_still_be_running',
        ...(partial_snapshot ? { partial_snapshot } : {}),
      });
      return { status: killed ? 'stopped' : 'detached', remote_outcome: killed ? 'confirmed_stopped' : 'unknown_may_still_be_running',
        ...(partial_snapshot ? { partial_snapshot } : {}) };
    }
    const key = keyOf('stop', session.id, call.id, operation.id);
    await this.processes.command(operation, { ...call, id: key }, 'stop', null, undefined, () => {});
    markStopRequested({
      detached_at: operation.detached_at || now,
      detached_reason: 'interrupted_by_user',
      remote_outcome: 'unknown_may_still_be_running',
      ...(partial_snapshot ? { partial_snapshot } : {}),
    });
    return { status: 'detached', remote_outcome: 'unknown_may_still_be_running', ...(partial_snapshot ? { partial_snapshot } : {}) };
  }

  listDetached() {
    return this.store.list(operationRecords)
      .filter(op => op.detached_at && !op.detached_dismissed_at)
      .map(op => {
        const entry = this.get(op.connection_id);
        const session = this.store.get(executionRecords, op.session_id);
        const alive = op.protocol !== 'service' ? this.processes.isAlive(op) : this.active.has(op.id);
        return this.clean({
          id: op.id,
          session_id: op.session_id,
          room_id: session?.origin_room?.id || (session?.space?.kind === 'room' ? session.space.id : null),
          connection_id: op.connection_id,
          connection_name: entry?.name || op.connection_id,
          protocol: op.protocol,
          method: op.method || op.work_method || null,
          status: op.status,
          alive,
          runner_pid: op.runner_pid || null,
          child_pid: op.child_pid || null,
          detached_at: op.detached_at,
          detached_reason: op.detached_reason || 'interrupted_by_user',
          remote_outcome: op.remote_outcome || (op.runtime_ended ? 'confirmed_stopped' : 'unknown_may_still_be_running'),
          partial_snapshot: op.partial_snapshot || null,
          late_receipt: op.late_receipt || null,
          runtime_ended: Boolean(op.runtime_ended),
          error: op.error || null,
        });
      })
      .sort((a, b) => (b.detached_at || '').localeCompare(a.detached_at || ''));
  }

  async killDetached(id, { dismiss = false } = {}) {
    const op = this.store.get(operationRecords, id);
    if (!op) reject('operation_not_found', 'Detached operation not found', 404);
    const now = new Date().toISOString();
    if (op.protocol === 'service') {
      const controller = this.active.get(op.id);
      if (controller && typeof controller.abort === 'function') {
        controller.abort(Object.assign(new Error('Force killed by user'), { code: 'interrupted_by_user' }));
      }
      const saved = this.saveOperation(op, {
        runtime_ended: true,
        ...(dismiss ? { detached_dismissed_at: now } : {}),
        remote_outcome: op.remote_outcome || 'unknown_may_still_be_running',
      });
      return { id: saved.id, killed: true, dismissed: dismiss, alive: false };
    }
    const killed = await this.processes.forceKill(op);
    const saved = this.saveOperation(op, {
      ...(killed ? { status: 'stopped', runtime_ended: true, finished_at: op.finished_at || now, remote_outcome: 'confirmed_stopped' } : {}),
      ...(dismiss ? { detached_dismissed_at: now } : {}),
    });
    return { id: saved.id, killed, dismissed: dismiss, alive: this.processes.isAlive(saved) };
  }

  async publish(operation, session) {
    const facts = this.operationFacts(operation, session);
    const signature = this.observationKey(operation, facts.status);
    if (!this.onEvent || facts.status === 'prepared' || operation.signature === signature ||
        operation.migrated && !operation.signature && settled(operation.status) && operation.status !== 'unknown' && !operation.recovered_at) return;
    const call = this.store.get('platform-calls', operation.id);
    if (call?.result_ref?.kind === 'call' && call.result?.status === facts.status &&
        call.result.code === facts.code &&
        (facts.status !== 'unknown' || call.result.safe_to_disconnect === facts.safe_to_disconnect) &&
        keyOf(call.result.native, call.result.input_targets) === keyOf(facts.native, facts.input_targets)) {
      this.saveOperation(operation, { signature });
      return;
    }
      if (operation.detached_at) {
        if (settled(facts.status) && !operation.late_receipt) {
          this.saveOperation(operation, {
            late_receipt: { at: new Date().toISOString(), status: facts.status, output: facts.output || null, error: facts.error || null },
            remote_outcome: facts.status === 'stopped' ? 'confirmed_stopped' : 'completed_after_detach',
            signature,
          });
        }
        return;
      }
      await this.onEvent(session.id, operation.id, { ...facts, position: keyOf('execution', operation.id, signature) });
      this.saveOperation(operation, { signature });
  }

  async publishWork(operation, session) {
    if (!session.group_work || !this.onWorkEvent || operation.work_done || operation.revoked_at || operation.status === 'prepared') return;
    const facts = this.operationFacts(operation, session);
    const report = (position, data) => this.onWorkEvent(session.id, operation.id, position, {
      program: operation.work_program, method: operation.work_method ?? operation.method, cwd: operation.cwd, ...data,
    });
    let offset = operation.work_offset ?? 0;
    let more = false;
    if (operation.instance_id) {
      const page = await this.processes.output(operation, { stream: 'events', offset, limit: 65_536 });
      for (const line of page.text.slice(0, page.text.lastIndexOf('\n') + 1).split('\n').slice(0, -1)) {
        offset += Buffer.byteLength(line) + 1;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'tool' && !(event.type === 'item' && ['commandExecution', 'mcpToolCall'].includes(event.itemType))) continue;
        const { itemId, phase, status, tool, itemType, command, text, output, exitCode } = event;
        const position = itemId && itemId.length <= 72 ? ['item', itemId, phase, status] : ['log', offset];
        report(position, { phase, status, tool: tool ?? itemType, command, text: (text ?? output)?.slice(0, 2000), exit_code: exitCode });
      }
      more = page.more || offset < page.next_offset;
    }
    const previous = operation.work_status;
    const status = facts.status;
    if (previous !== status) {
      let diagnostic = facts.error;
      if (!diagnostic && operation.instance_id && status === 'failed')
        diagnostic = (await this.processes.output(operation, { stream: 'stderr', limit: 2048 })).text;
      report(['status', status], { phase: 'execution', status, code: facts.code,
        text: diagnostic?.slice(0, 2000), exit_code: operation.exit_code, http_status: operation.result?.http_status ?? operation.http_status });
    }
    if (offset !== operation.work_offset || status !== previous || settled(status) && operation.runtime_ended && !more)
      this.saveOperation(operation, { work_offset: offset, work_status: status,
        work_done: settled(status) && operation.runtime_ended && !more });
  }

  async publishInputs(operation, session, inputs = []) {
    for (const record of inputs) {
      let next = record;
      if (operation.instance_id) next = await this.processes.inputReceipt(operation, record);
      else if (!record.receipt && !this.locks.has(session.id))
        next = this.store.save(inputRecords, { id: record.id, receipt: { status: record.status === 'submitted' ? 'unknown' : 'not_submitted' } });
      if (next.kind === 'stop' || next.suppressed || !this.onEvent || !next.receipt) continue;
      const signature = next.native_acknowledged ? keyOf(next.receipt.status, next.receipt.execution_status, 'native_acknowledged') :
        keyOf(next.receipt.status, next.receipt.execution_status);
      if (signature === next.signature) continue;
      const facts = this.commandFacts(next, operation, session);
      const call = this.store.get('platform-calls', next.id);
      if (call?.status === facts.status && call.result_ref?.kind === 'call' && call.result &&
          (!facts.confirmed_input || call.result.input_status === facts.input_status && isDeepStrictEqual(call.result.output, facts.output))) {
        this.store.save(inputRecords, { id: next.id, signature });
        continue;
      }
      const latest = this.operations(session).at(-1);
      const current = this.operationFacts(latest || operation, session);
      await this.onEvent(session.id, next.id, { ...facts, input_revision: current.input_revision, input_targets: current.input_targets,
        native: current.native, session_status: current.status, position: keyOf('input', next.id, signature) });
      this.store.save(inputRecords, { id: next.id, signature });
    }
  }

  locallyAuthorized(session, operation, entry) {
    const actor = session.execution_actor;
    if (!this.authorized(entry, actor) || session.authority_revoked ||
        operation.connection_binding_version !== undefined && operation.connection_binding_version !== (entry.binding_version ?? 1)) return false;
    if (session.sharing && !this.store.get('rooms', session.space.id)?.members?.includes(session.owner.id)) return false;
    if (actor.kind !== 'user' && !this.store.get('platform-bots', actor.id)) return false;
    return !session.workspace_ref || workspaceGranted((kind, id) => this.store.get(kind, id), actor,
      session.workspace_ref.id, session.project_room, session.room_workspace_id);
  }

  tick() {
    if (this.closed) return;
    return this.ticking ||= this.observe().finally(() => { this.ticking = null; });
  }

  async observe() {
    const groups = Map.groupBy(this.store.list(operationRecords), item => item.session_id);
    const inputs = Map.groupBy(this.store.list(inputRecords), item => item.operation_id);
    const checks = [...groups].map(async ([sessionId, operations]) => {
      let session = this.store.get(executionRecords, sessionId);
      if (!session || this.locks.has(sessionId)) return;
      const latest = operations.sort((left, right) => (left.input_revision ?? 0) - (right.input_revision ?? 0)).at(-1);
      let current = await this.refresh(latest, session, { reconcile: true });
      session = this.store.get(executionRecords, sessionId);
      if (!session) return;
      if (this.locks.has(sessionId) || this.operations(session).at(-1)?.id !== current.id) return;
      const entry = this.get(current.connection_id);
      if (!current.revoked_at && !this.locallyAuthorized(session, current, entry)) {
        current = this.saveOperation(current, { revoked_at: new Date().toISOString() });
        this.store.save(executionRecords, { id: session.id, authority_revoked: true });
      }
      if ((current.revoked_at || current.stop_requested_at) && !settled(current.status)) {
        const stopId = keyOf(current.revoked_at ? 'revoked' : 'recover-stop', current.id);
        try { await this.stopOperation(current, session, { id: stopId, submitted_by: user }); }
        catch { /* The original outcome remains pending or unknown. */ }
      }
      if ((current.revoked_at || current.stop_requested_at) && current.status === 'unknown' && !current.runtime_ended &&
          current.protocol !== 'service' && this.processes.isAlive(current)) {
        try { await this.processes.forceKill(current); } catch {}
      }
      for (const operation of operations) {
        if (operation.id === current.id) continue;
        await this.publish(operation, session);
        await this.publishInputs(operation, session, inputs.get(operation.id));
        await this.publishWork(operation, session);
      }
      await this.publish(current, session);
      await this.publishInputs(current, session, inputs.get(current.id));
      await this.publishWork(current, session);
    });
    const results = await Promise.allSettled(checks);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  safeToDisconnect(operation) {
    if (operation.detached_at) return true;
    if (settled(operation.status)) {
      if (operation.status !== 'unknown') return true;
      return Boolean(operation.runtime_ended || (operation.protocol !== 'service' && !this.processes.isAlive(operation)));
    }
    // Detached native processes (Codex/CLI) survive Gateway restart independently via state.json.
    if (operation.protocol !== 'service' && operation.runner_pid &&
        ['running', 'awaiting-input', 'stopping'].includes(operation.status)) {
      return true;
    }
    return false;
  }

  async drainStatus() {
    await this.tick();
    const operations = this.store.list(operationRecords);
    const active = operations.filter(item => !this.safeToDisconnect(item))
      .map(item => ({ kind: item.protocol === 'service' ? 'service_call' : item.protocol === 'codex' ? 'codex_turn' : 'cli_process',
        id: item.id, session_id: item.session_id, call_id: item.id, protocol: item.protocol, status: item.status,
        native: { instance_id: item.instance_id, thread_id: item.thread_id, turn_id: item.turn_id, operation_id: item.operation_id },
        safe_to_disconnect: false }));
    const outstanding = this.store.list(inputRecords).filter(item => !item.migrated && !item.receipt && ['writing', 'submitted'].includes(item.status));
    for (const input of outstanding) {
      if (!active.some(item => item.call_id === input.operation_id))
        active.push({ kind: 'execution_input', id: input.id, call_id: input.id, status: input.status, safe_to_disconnect: false });
    }
    return { active, ready: active.length === 0 };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.locks.values(), this.ticking, this.services.close()]);
    this.closed = true;
  }
}
