import { hostname } from 'node:os';
import { readdir, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathWithin } from '../../bot/src/capabilities/file-policy.mjs';
import { assertRevision, reject, sameIdentity, user } from '../platform/contract.mjs';
import { allowsConnection, allowsExecutable } from '../services/executable-scope.mjs';
import { bindingOf, httpMethods, httpTarget, pathKey, protocolOf, sameBinding, serviceUrl } from '../services/connection-binding.mjs';
import { canSupplyProcessArguments, connectionRecords, executionRecords, plain } from '../services/connection-records.mjs';
import { connectionExecutable, registeredScript } from '../services/connection-launch.mjs';
import { hasExplicitFileScope, nativeFileArgs } from '../services/native-file-arguments.mjs';
import { localExecutable, nativeArgs } from '../services/native-host.mjs';
import { validateNativeProbe, visibleProbe } from '../services/native-probe.mjs';
import { credentialNames } from '../services/service-connection.mjs';
import { sshBinding } from '../services/ssh-binding.mjs';
import { targetAllows } from './onboarding-access.mjs';

const localHost = () => ({ hostname: hostname(), platform: process.platform });
const canInspectHere = environment => environment.kind === 'local' && isDeepStrictEqual(environment.host, localHost());
const windows = process.platform === 'win32';
const programName = path => (windows ? basename(path, extname(path)) : basename(path)).toLowerCase();
const native = entry => entry && ['cli', 'codex'].includes(entry.kind);
const inPaths = (paths, file) => paths.some(path => pathKey(path) === pathKey(file));
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,119}$/;
const routedHeaders = /^(?:host|forwarded|x-forwarded-.*|connection|proxy-.*|upgrade|transfer-encoding|content-length)$/i;
const protectedEnvironment = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|HOME|USERPROFILE|CODEX_HOME|NODE_OPTIONS|LD_.*|DYLD_.*)$/i;
const nativeKeys = ['file', 'canonical_file', 'workspace_root', 'workspace_write', 'credential_refs', 'detected_version', 'adapter',
  'methods', 'ssh', 'model', 'effort', 'app_server_stdio', 'launch_arguments', 'probe'];
const methodKeys = ['id', 'name', 'description', 'args', 'file_args', 'effect', 'input', 'keep_input', 'env'];

export function executionEnvironment(entry) {
  if (!entry) return { kind: 'local', host: localHost() };
  const protocol = protocolOf(entry);
  if (protocol === 'ssh') {
    const { host, port, user } = sshBinding(entry.config.ssh);
    return { kind: 'remote', protocol, host, port, user };
  }
  if (protocol === 'http' || protocol === 'mcp' && entry.config.transport === 'http') {
    const url = serviceUrl(entry.config.service_url || entry.config.url);
    return { kind: 'remote', protocol, ...(url ? { endpoint: new URL(url).origin } : {}) };
  }
  return { kind: 'local', host: localHost() };
}

export class ConnectionOnboarding {
  constructor(platform) { this.platform = platform; }

  entries() {
    return this.platform.store.list(connectionRecords);
  }

  visible(entry, context) {
    return this.platform.canUseConnection(context.actor, entry.id, context);
  }

  environment(args, context) {
    const { target } = args;
    if (target) {
      if (!this.platform.canReadReference(target, context))
        reject('environment_forbidden', 'Choose an accessible execution, connection or room tool event', 403);
      if (target.kind === 'connection') return executionEnvironment(this.platform.connections.get(target.id));
      if (target.kind === 'session') {
        const session = this.platform.store.get(executionRecords, target.id);
        return { ...(session.execution_environment ?? executionEnvironment(this.platform.connections.get(session.engine))),
          workspace: session.workspace_ref, cwd: session.workspace?.path };
      }
      if (target.kind === 'event') {
        const event = this.platform.store.get('platform-events', target.id);
        if (event?.type === 'work.tool') return event.environment;
      }
      reject('invalid_environment', 'Use an execution, connection or room tool event as the target');
    }
    const workspace = this.platform.workspace(args.workspace, context) ?? context.session?.workspace;
    return { kind: 'local', host: localHost(), workspace: workspace?.ref ?? context.session?.workspace_ref, cwd: workspace?.path };
  }

  async discovery(args, context, setup) {
    const environment = this.environment(args, context);
    if (!canInspectHere(environment)) return { environment, status: 'environment_unobserved', items: [],
      reason: 'This execution target has no local PATH observation. Use records from its actual environment.' };
    const { policy } = setup;
    const { connections: host } = this.platform;
    const { command, executable, required_version } = args;
    const term = args.query?.trim().toLowerCase() || '';
    if (command !== undefined && !namePattern.test(command) || executable !== undefined && (!isAbsolute(executable) || executable.includes('\0')))
      reject('invalid_executable', 'Use a command name or absolute executable path');
    const visible = this.entries().filter(entry => this.visible(entry, context));
    const registeredNative = this.entries().filter(native);
    const eligible = file => allowsExecutable(context.executable_scope, file) &&
      (!setup.executables || allowsExecutable(setup.executables, file));
    const described = visible.filter(entry => native(entry) && eligible(entry.config.canonical_file) &&
      (!executable || inPaths([entry.config.file, entry.config.canonical_file], executable)) &&
      (!command || programName(entry.config.file) === programName(command)) &&
      (!term || [entry.name, entry.description, basename(entry.config.file), ...(entry.config.methods ?? []).flatMap(method =>
        [method.id, method.name, method.description])].some(value => String(value ?? '').toLowerCase().includes(term))));
    const directories = policy?.discover.directories ?? [];
    const path = policy?.discover.path === true;
    const searchRoots = [...new Set([...directories, ...(path ? (process.env.PATH || '').split(delimiter).filter(isAbsolute) : [])])];
    const chosen = [...(policy?.executables ?? []), ...(setup.executables ?? []).map(item => item.file), ...described.map(entry => entry.config.file)];
    const matchesName = file => command ? programName(file) === programName(command) : !term || basename(file).toLowerCase().includes(term);
    const candidates = new Set([...chosen.filter(matchesName), ...described.map(entry => entry.config.file)]);
    if (executable) {
      candidates.clear();
      if (inPaths(chosen, executable) || inPaths(searchRoots, dirname(executable))) candidates.add(executable);
    } else {
      for (const root of searchRoots) {
        const files = await readdir(root, { withFileTypes: true }).catch(() => []);
        for (const file of files) if (!file.isDirectory() && matchesName(file.name)) candidates.add(join(root, file.name));
      }
    }
    const found = new Map();
    for (const file of candidates) {
      context.signal?.throwIfAborted();
      if (found.size === 60) break;
      try {
        const actual = await localExecutable(file);
        if (!eligible(actual.canonicalFile) || found.has(pathKey(actual.canonicalFile))) continue;
        await connectionExecutable({ config: { file, canonical_file: actual.canonicalFile } }, host.dataRoot, host.dataRoot);
        found.set(pathKey(actual.canonicalFile), actual);
      } catch { /* The scope can include missing PATH entries and non-executables. */ }
    }
    const workspaces = this.platform.workspaceRecords().filter(workspace => this.platform.workspaceAvailable(workspace.id, context.actor, context));
    const items = [...found.values()].map(actual => {
      const matching = visible.filter(entry => native(entry) && inPaths([entry.config.canonical_file], actual.canonicalFile));
      const registered = registeredNative.some(entry => inPaths([entry.config.canonical_file], actual.canonicalFile));
      const usable = matching.some(entry => host.authorized(entry, context.actor) && host.available(entry) &&
        workspaces.some(workspace => (entry.kind === 'codex' || workspace.write && entry.config.workspace_write !== false) &&
          (environment.cwd ? pathWithin(workspace.path, environment.cwd) &&
            (!entry.config.workspace_root || pathWithin(entry.config.workspace_root, environment.cwd)) :
            !entry.config.workspace_root || pathWithin(entry.config.workspace_root, workspace.path) ||
            pathWithin(workspace.path, entry.config.workspace_root))));
      const versions = matching.map(entry => entry.config.detected_version ?? entry.version).filter(Boolean);
      const versionMatches = !required_version || versions.includes(required_version);
      return { file: actual.file, canonical_file: actual.canonicalFile, name: actual.name,
        status: usable && versionMatches ? 'connection_available' : usable ? (versions.length ? 'version_mismatch' : 'version_unobserved') :
          registered ? 'connection_unavailable' : 'installed_unregistered',
        connections: matching.map(entry => ({ ...host.summary(entry, host.available(entry)), ...this.platform.connectionMaintenance(entry, context) })) };
    });
    for (const entry of described) if (!found.has(pathKey(entry.config.canonical_file)) && items.length < 60) items.push({
      file: entry.config.file, canonical_file: entry.config.canonical_file, name: entry.name, status: 'connection_unavailable',
      connections: [{ ...host.summary(entry, false), ...this.platform.connectionMaintenance(entry, context) }],
    });
    return host.clean({ environment, scope: { path, directories, registered_paths: true, selected_executables: chosen.length > 0 },
      status: items.length ? 'observed' : 'not_found_in_scope', items, ...(found.size === 60 ? { limited: true } : {}) });
  }

  probeRunner(script, entry, context) {
    const { platform } = this;
    const host = platform.connections;
    const runner = host.get(script.runner.id);
    const actor = context.actor;
    if (!runner || runner.id === entry.id || protocolOf(runner) !== 'cli' || runner.config.adapter ||
        (runner.binding_version ?? 1) !== script.runner.binding_version ||
        !platform.canUseConnection(actor, runner.id, context) || !host.authorized(runner, actor) ||
        !canSupplyProcessArguments(runner, actor))
      reject('script_runner_forbidden', 'The probe script needs its registered runner and the current use and direct argument grants', 403);
    return runner;
  }

  async inspect(args, context, setup, initializer, definition, selected, call) {
    const environment = selected && !args.target ? executionEnvironment(selected) : this.environment(args, context);
    if (!canInspectHere(environment)) return { environment, available: false, status: 'environment_unobserved' };
    const unavailable = (status, reason) => ({ environment, available: false, status, reason });
    const { platform } = this;
    const host = platform.connections;
    const bound = native(selected) && !selected.config.ssh ? selected : null;
    if (selected && !bound)
      return unavailable('probe_unsupported', 'Version and help probes need a local CLI connection. Use read for service connection details');
    const trial = args.probe !== undefined;
    const custom = trial || args.diagnostic_args !== undefined;
    if (custom && !bound) reject('connection_required', 'Select a registered CLI connection to try probe arguments');
    if (bound && args.executable && !inPaths([bound.config.file, bound.config.canonical_file], args.executable))
      reject('connection_binding_conflict', 'Inspect uses the registered executable for this connection', 409);
    const allowed = (access, entry, file) => allowsExecutable(context.executable_scope, file) &&
      (!entry || host.authorized(entry, context.actor)) &&
      (inPaths(access.policy?.executables ?? [], file) || allowsExecutable(access.executables ?? [], file) ||
        entry && platform.probeRepairAllowed(entry, context));
    const missingGrant = () => unavailable('probe_authorization_required', bound ?
      'Probing this connection needs its repair grant or a host executable grant for its registered path. Check can_use and can_repair with read' :
      'Select a readable local connection with a repair grant using target or connection, or specify a host-granted executable');
    if ((args.connection || args.target?.kind === 'connection') && !bound) return missingGrant();
    if (bound && !allowed(setup, bound, bound.config.canonical_file)) return missingGrant();
    if (custom && !platform.probeRepairAllowed(bound, context))
      reject('probe_repair_forbidden', 'Trying custom probe arguments requires repair authority for this connection', 403);
    if (bound && (trial || args.revision !== undefined)) assertRevision(bound.revision, args.revision);
    const rules = trial ? validateNativeProbe(args.probe) : bound?.config.probe;

    const target = bound ? { executable: bound.config.file } : args;
    const paths = bound ? [{ file: bound.config.file, canonical_file: bound.config.canonical_file }] :
      [...(setup.executables ?? []), ...(setup.policy?.executables ?? []).map(file => ({ file, canonical_file: file }))];
    const found = await initializer.locate(target, definition, { executables: paths });
    if (!found) return bound ?
      unavailable('executable_unavailable', 'The registered path is missing or no longer resolves to the registered executable. Ask the host to check the binding') :
      missingGrant();
    if (!allowed(setup, bound, found.canonicalFile)) return missingGrant();

    const directory = bound?.config.workspace_root ?? host.workspace;
    const scoped = bound?.config.workspace_root || context.session?.workspace || rules?.script;
    const workspace = () => scoped ? platform.workspace(directory, context) : null;
    const grant = workspace();
    const cwd = grant?.path ?? await realpath(directory);
    const pathPolicy = context.session?.path_policy ?? {};
    if ((custom || rules) && (grant?.write === false || bound?.config.workspace_write === false || hasExplicitFileScope(pathPolicy)))
      reject('scoped_process_unsupported', 'Custom CLI probes require the bound execution directory with writable process access', 403);
    const authorize = () => {
      const current = platform.requireConnectionSetup(context, args);
      const live = current.connection;
      if (bound && (live?.id !== bound.id || live.revision !== bound.revision ||
          !inPaths([live.config.canonical_file], found.canonicalFile)))
        reject('connection_binding_changed', 'The registered binding or revision changed while probing. Read the current connection before retrying', 409);
      if (!allowed(current, live, found.canonicalFile) || custom && !platform.probeRepairAllowed(live, context))
        reject('probe_authorization_required', 'The current connection or executable probe grant changed', 403);
      if (grant && !isDeepStrictEqual(workspace(), grant))
        reject('workspace_changed', 'The bound probe directory grant changed', 409);
      if (rules?.script) this.probeRunner(rules.script, live, context);
    };
    authorize();
    if (bound) await connectionExecutable(bound, cwd, host.dataRoot, pathPolicy);
    let script;
    if (rules?.script) {
      const { path, source } = rules.script;
      if (path !== undefined && !inPaths([bound.config.probe?.script?.path, ...(bound.config.methods ?? []).map(item => item.script)]
        .filter(Boolean), path))
        reject('script_not_authorized', 'Use a script path already approved for this connection', 403);
      const runner = this.probeRunner(rules.script, bound, context);
      if (runner.config.workspace_write === false ||
          runner.config.workspace_root && !pathWithin(await realpath(runner.config.workspace_root), cwd))
        reject('workspace_forbidden', 'The registered probe runner is outside the bound working directory', 403);
      script = { file: await connectionExecutable(runner, cwd, host.dataRoot, pathPolicy),
        ...(path === undefined ? { source } : { path: await registeredScript(host.dataRoot, bound.id, path) }) };
    }
    const observed = await initializer.probe(found, definition, args, context, {
      cwd, rules, script, source: trial ? 'candidate' : rules ? 'saved' : 'default', authorize,
    });
    authorize();
    let maintenance;
    if (bound) {
      platform.store.transaction(() => {
        platform.calls.bind(call.id, { target: { kind: 'connection', id: bound.id },
          ...(trial && observed.status === 'observed' ? { probe_verification: { revision: bound.revision, rules,
            version: host.clean(observed.version) } } : {}) });
        if (trial) return;
        if (observed.status === 'observed') platform.resolveProbeFailure(bound.id);
        else if (observed.status === 'probe_rule_mismatch') maintenance = platform.noteProbeFailure(bound, context, observed);
      });
    }
    return { environment: { ...environment, cwd }, found, observed, connection: bound, maintenance };
  }

  async nativeConfig(proposed, protocol, context, previous) {
    if (Object.hasOwn(proposed, 'version'))
      reject('invalid_connection', 'Use config.detected_version to save the version returned by inspect. The version field is used in tool results');
    if (Object.hasOwn(proposed, 'detected_version') && (typeof proposed.detected_version !== 'string' || !proposed.detected_version.trim()))
      reject('invalid_connection', 'Set config.detected_version to a non-empty version string observed by inspect');
    let config = { ...previous?.config, ...proposed };
    if (typeof config.file !== 'string' || !isAbsolute(config.file) || Object.keys(proposed).some(key => !nativeKeys.includes(key)))
      reject('invalid_connection', 'Specify an absolute executable and supported native settings');
    const found = await localExecutable(config.file);
    config = { ...config, file: found.file, canonical_file: found.canonicalFile, ...(!previous ? { allow_arguments: false } : {}) };
    await connectionExecutable({ config }, this.platform.dataRoot, this.platform.dataRoot);
    if (!allowsExecutable(context.executable_scope, found.canonicalFile))
      reject('executable_scope_forbidden', 'The executable is outside the current execution scope', 403);
    if (proposed.workspace_root !== undefined) {
      const workspace = this.platform.workspace(config.workspace_root, context);
      config.workspace_root = workspace.path;
      config.workspace_write = config.workspace_write !== false && workspace.write;
    }
    if (protocol === 'ssh') {
      if (found.name.toLowerCase() !== 'ssh' || programName(found.canonicalFile) !== 'ssh')
        reject('invalid_ssh_binding', 'Choose the approved OpenSSH client executable');
      config.ssh = sshBinding(config.ssh);
    } else if (config.ssh !== undefined) reject('invalid_ssh_binding', 'Choose the SSH protocol to bind a remote target');
    if (proposed.methods !== undefined) {
      if (!Array.isArray(config.methods)) reject('invalid_connection', 'Specify an array of CLI methods');
      config.methods.forEach(method => this.nativeMethod(method, config));
    }
    const runner = config.adapter?.runner;
    if (config.adapter?.source !== undefined) {
      const entry = this.platform.connections.get(runner?.id);
      if (entry?.kind !== 'cli' || entry.config.adapter || !this.visible(entry, context) ||
          !this.platform.connections.authorized(entry, context.actor) || !canSupplyProcessArguments(entry, context.actor) ||
          runner.binding_version !== (entry.binding_version ?? 1))
        reject('script_runner_forbidden', 'Use an authorized runner with its current binding version and direct argument grant', 403);
      await connectionExecutable(entry, this.platform.dataRoot, this.platform.dataRoot);
    }
    return config;
  }

  nativeMethod(method, config) {
    if (!plain(method) || Object.keys(method).some(key => !methodKeys.includes(key)) ||
        typeof method.id !== 'string' || !method.id.trim() || method.id.length > 120 || !Array.isArray(method.args) ||
        method.keep_input !== undefined && typeof method.keep_input !== 'boolean' ||
        method.input !== undefined && (typeof method.input !== 'string' || method.input.includes('\0') || method.input.length > 32_768) ||
        method.effect !== undefined && !['read', 'write', 'process', 'external'].includes(method.effect) ||
        method.env !== undefined && (!plain(method.env) || Object.entries(method.env).some(([key, ref]) =>
          protectedEnvironment.test(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !config.credential_refs?.includes(ref?.env))))
      reject('invalid_connection', 'Specify a CLI method ID, argument template and permitted credential references');
    nativeArgs(method.args);
    nativeFileArgs(method.file_args, method.args.length, method.effect);
  }

  async serviceConfig(config, protocol, context) {
    if (protocol === 'http') {
      if (!serviceUrl(config.service_url) || !Array.isArray(config.tools) || !config.tools.length)
        reject('invalid_connection', 'Specify the actual HTTP service URL and method definitions');
      config = { ...config, service_url: serviceUrl(config.service_url) };
    }
    if (protocol === 'mcp' && config.transport === 'stdio') {
      if (typeof config.command !== 'string' || !isAbsolute(config.command))
        reject('invalid_connection', 'Bind MCP stdio to an absolute executable');
      const command = await localExecutable(config.command);
      await connectionExecutable({ config: { file: command.file, canonical_file: command.canonicalFile } }, this.platform.dataRoot, this.platform.dataRoot);
      if (!allowsExecutable(context.executable_scope, command.canonicalFile)) reject('executable_scope_forbidden', 'The MCP program is outside this scope', 403);
      const workspace = this.platform.workspace(config.workspace_root, context);
      if (!workspace?.write) reject('workspace_forbidden', 'MCP stdio needs its authorized writable launch directory', 403);
      config = { ...config, canonical_command: command.canonicalFile, workspace_root: workspace.path, workspace_write: true };
    }
    const definitions = protocol === 'http' ? config.tools : [config];
    if (definitions.some(definition => !plain(definition) || Object.keys(definition.headersEnv ?? {}).some(name => routedHeaders.test(name))) ||
        Object.keys(config.env ?? {}).some(name => protectedEnvironment.test(name)))
      reject('invalid_connection', 'Connection credentials cannot override routing or process setup');
    if (!(protocol === 'mcp' && config.transport === 'stdio') && credentialNames({ kind: protocol, config }).length && !config.account)
      reject('invalid_connection', 'Name the host-authorized service account when using credentials');
    return config;
  }

  assertWrite(entry, previous, context) {
    const policy = this.platform.accessFor(context.actor).execution_onboarding;
    if (!allowsConnection(context.executable_scope, entry, id => this.platform.connections.get(id)))
      reject('executable_scope_forbidden', 'The connection is outside the current execution scope', 403);
    if (previous && !sameBinding(previous, entry)) reject('connection_binding_conflict', 'Update methods on the same connection binding', 409);
    if (previous && this.platform.repairableConnection(previous, context)) {
      const protocol = protocolOf(previous);
      if ((protocol === 'cli' || protocol === 'codex') &&
          previous.config.adapter?.runner?.id === entry.config.adapter?.runner?.id) return;
      if (protocol === 'http' && httpMethods(entry.config).every(method => httpMethods(previous.config).some(current =>
        isDeepStrictEqual(httpTarget(method), httpTarget(current)) && isDeepStrictEqual(method.headersEnv ?? {}, current.headersEnv ?? {})))) return;
      if (protocol === 'mcp' && isDeepStrictEqual(previous.config, entry.config)) return;
    }
    if (!policy?.submit || !targetAllows(policy, entry))
      reject('connection_registration_forbidden', 'The host must allow configuration submissions for this executable or service target and its credentials', 403);
    if (previous && !this.visible(previous, context)) reject('connection_forbidden', 'This connection is outside the current execution grants', 403);
  }

  async register(args, context, setup, call, previous) {
    const { protocol } = args;
    if (!protocol || !plain(args.config) || args.adapter || args.connection && (!previous || protocolOf(previous) !== protocol))
      reject('invalid_connection', 'Submit protocol and config for the actual binding');
    if (!previous && !setup.policy?.submit) reject('connection_registration_forbidden', 'Enable configuration submissions in the Bot’s host grant', 403);
    const probeUpdate = Object.hasOwn(args.config, 'probe');
    if (probeUpdate) {
      if (!previous || !['cli', 'codex'].includes(protocol) || Object.keys(args.config).some(key => !['probe', 'detected_version'].includes(key)))
        reject('invalid_probe', 'Save the probe and detected_version on an existing local CLI connection');
      args = { ...args, config: { ...args.config, probe: validateNativeProbe(args.config.probe) } };
      this.verifyProbeUpdate(args, previous, context);
    }
    const kind = protocol === 'ssh' ? 'cli' : protocol;
    if (['cli', 'codex'].includes(protocol) && args.target && !canInspectHere(this.environment(args, context)))
      reject('environment_unobserved', 'Use authorization from the actual execution host');
    const config = ['cli', 'codex'].includes(kind) ? await this.nativeConfig(args.config, protocol, context, previous)
      : await this.serviceConfig({ ...previous?.config, ...args.config }, protocol, context);
    if (!bindingOf({ kind, config })) reject('invalid_connection', 'Specify the actual execution binding');
    const name = (probeUpdate ? previous.name : args.name?.trim()) || previous?.name || basename(config.file ?? config.command ?? '') || config.service_url || config.url;
    if (!name || name.length > 120) reject('invalid_connection', 'Use a connection name of at most 120 characters');
    const priorRunner = previous?.config.adapter?.runner?.id;
    const dependencies = [...new Set([...(previous?.dependencies ?? []).filter(id => id !== priorRunner),
      ...(config.adapter?.runner ? [config.adapter.runner.id] : [])])];
    return this.save({ id: previous?.id ?? call.id, revision: args.revision, kind, name, config,
      dependencies: probeUpdate ? previous.dependencies : dependencies,
      ...(!previous ? { allowed_bot_ids: [context.actor.id] } : {}) }, context, call, probeUpdate ? args : undefined);
  }

  verifyProbeUpdate(args, previous, context) {
    assertRevision(previous.revision, args.revision);
    if (!this.platform.probeRepairAllowed(previous, context))
      reject('probe_repair_forbidden', 'Saving probe rules requires repair authority for this connection', 403);
    const inspection = args.probe_call && this.platform.store.get('platform-calls', args.probe_call);
    const candidate = inspection?.probe_verification;
    if (!candidate || inspection.status !== 'completed' || inspection.tool !== 'initialize_execution' || !sameIdentity(inspection.submitted_by, context.actor) ||
        inspection.target?.id !== previous.id ||
        candidate.revision !== previous.revision || !isDeepStrictEqual(candidate.rules, args.config.probe) ||
        candidate.version !== args.config.detected_version)
      reject('probe_observation_required', 'Use the probe_call of a successful candidate inspect with the same probe, detected_version and current connection revision', 409);
    if (args.config.probe.script) this.probeRunner(args.config.probe.script, previous, context);
  }

  upsert(args, context, call, selected) {
    if (!selected || !plain(args.method)) reject('invalid_connection', 'Select an authorized connection and one method');
    const kind = protocolOf(selected);
    const config = { ...selected.config };
    let method = args.method;
    const upsert = (methods, field) => methods.some(item => item[field] === method[field]) ?
      methods.map(item => item[field] === method[field] ? method : item) : [...methods, method];
    if (kind === 'cli' && !config.adapter) {
      const methods = config.methods ?? [];
      method = { ...methods.find(item => item.id === method.id), ...method };
      this.nativeMethod(method, config);
      config.methods = upsert(methods, 'id');
    } else if (kind === 'ssh') config.ssh = sshBinding({ ...config.ssh, operations: upsert(config.ssh.operations, 'id') });
    else if (kind === 'http') {
      method = { ...httpMethods(config).find(item => item.name === method.name), ...method };
      if (!method.name || !httpTarget(method).url || Object.keys(method.headersEnv ?? {}).some(name => routedHeaders.test(name)))
        reject('invalid_connection', 'Specify an HTTP method name and the authorized URL and credential references');
      config.tools = upsert(httpMethods(config), 'name');
    } else reject('invalid_connection', 'This protocol exposes its methods through the native adapter or MCP tool discovery');
    return this.save({ id: selected.id, revision: args.revision, config }, context, call);
  }

  save(input, context, call, probeUpdate) {
    return this.platform.configureExecutionConnection(input, {
      actor: user,
      canSeeBinding: entry => this.visible(entry, context),
      beforeConnectionSave: (entry, previous) => {
        this.platform.assertRunAllowed(context);
        this.assertWrite(entry, previous, context);
        if (probeUpdate) this.verifyProbeUpdate(probeUpdate, previous, context);
        const runner = entry.config.adapter?.runner;
        if (runner) {
          const live = this.platform.connections.get(runner.id);
          if (!live || (live.binding_version ?? 1) !== runner.binding_version ||
              !this.visible(live, context) || !this.platform.connections.authorized(live, context.actor) ||
              !canSupplyProcessArguments(live, context.actor))
            reject('script_runner_forbidden', 'The authorized adapter runner changed', 409);
        }
      },
    }, result => {
      this.platform.calls.bind(call.id, { target: { kind: 'connection', id: result.id } });
      if (probeUpdate) this.platform.resolveProbeFailure(result.id);
      this.platform.calls.finish(call.id, 'completed', probeUpdate ?
        { ...result, probe: this.platform.connections.clean(visibleProbe(input.config.probe)) } : result);
    });
  }
}
