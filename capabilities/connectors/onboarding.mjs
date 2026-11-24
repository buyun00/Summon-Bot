import { hostname } from 'node:os';
import { readdir, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathWithin } from '../../bot/src/capabilities/file-policy.mjs';
import { nativeProbeArgs, reject, user } from '../platform/contract.mjs';
import { bindingOf, httpMethods, httpTarget, pathKey, protocolOf, sameBinding, serviceUrl } from '../services/connection-binding.mjs';
import { canSupplyProcessArguments, connectionRecords, executionRecords, plain } from '../services/connection-records.mjs';
import { connectionExecutable } from '../services/connection-launch.mjs';
import { inspectNative, localExecutable, nativeArgs } from '../services/native-host.mjs';
import { credentialNames } from '../services/service-connection.mjs';
import { sshBinding } from '../services/ssh-binding.mjs';

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
  'methods', 'ssh', 'model', 'effort', 'sandbox', 'approval_policy', 'app_server_stdio', 'launch_arguments', 'allow_arguments'];
const methodKeys = ['id', 'name', 'description', 'args', 'effect', 'input', 'keep_input', 'env', 'protocol', 'script'];

const INSPECT_TIMEOUT_MS = 15_000;
const INSPECT_OUTPUT_LIMIT = 256_000;

function trimOutput(value) {
  const text = String(value ?? '');
  return text.length > INSPECT_OUTPUT_LIMIT ? `${text.slice(0, INSPECT_OUTPUT_LIMIT)}\n...[truncated]` : text;
}

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
    const { connections: host } = this.platform;
    const { command, executable, required_version } = args;
    const term = args.query?.trim().toLowerCase() || '';
    if (command !== undefined && !namePattern.test(command) || executable !== undefined && (!isAbsolute(executable) || executable.includes('\0')))
      reject('invalid_executable', 'Use a command name or absolute executable path');
    const visible = this.entries().filter(entry => this.visible(entry, context));
    const registeredNative = this.entries().filter(native);
    const described = visible.filter(entry => native(entry) &&
      (!executable || inPaths([entry.config.file, entry.config.canonical_file], executable)) &&
      (!command || programName(entry.config.file) === programName(command)) &&
      (!term || [entry.name, entry.description, basename(entry.config.file), ...(entry.config.methods ?? []).flatMap(method =>
        [method.id, method.name, method.description])].some(value => String(value ?? '').toLowerCase().includes(term))));
    const searchRoots = [...new Set((process.env.PATH || '').split(delimiter).filter(isAbsolute))];
    const chosen = [...(setup.executables ?? []).map(item => item.file), ...described.map(entry => entry.config.file)];
    const matchesName = file => command ? programName(file) === programName(command) : !term || basename(file).toLowerCase().includes(term);
    const candidates = new Set([...chosen.filter(matchesName), ...described.map(entry => entry.config.file)]);
    if (executable) {
      candidates.clear();
      candidates.add(executable);
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
        if (found.has(pathKey(actual.canonicalFile))) continue;
        await connectionExecutable({ config: { file, canonical_file: actual.canonicalFile } }, host.dataRoot, host.dataRoot);
        found.set(pathKey(actual.canonicalFile), actual);
      } catch { /* Ignore missing PATH entries, non-executables, and protected host paths. */ }
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
    return host.clean({ environment, status: items.length ? 'observed' : 'not_found_in_scope', items,
      ...(found.size === 60 ? { limited: true } : {}) });
  }

  async inspect(args, context, setup, initializer, definition, selected, call) {
    const environment = selected && !args.target ? executionEnvironment(selected) : this.environment(args, context);
    if (!canInspectHere(environment)) return { environment, available: false, status: 'environment_unobserved' };
    const unavailable = (status, reason) => ({ environment, available: false, status, reason });
    const { platform } = this;
    const host = platform.connections;
    const bound = native(selected) && !selected.config.ssh ? selected : null;
    if (selected && !bound)
      return unavailable('probe_unsupported', 'CLI inspect requires a local CLI or Codex connection. Use read for service connection details');
    if (bound && args.executable && !inPaths([bound.config.file, bound.config.canonical_file], args.executable))
      reject('connection_binding_conflict', 'Inspect uses the registered executable for this connection', 409);

    const target = bound ? { executable: bound.config.file } : args;
    const found = await initializer.locate(target, definition, setup);
    if (!found) return unavailable('executable_unavailable',
      bound ? 'The registered executable path is missing or inaccessible' : 'The executable was not found in PATH or at the specified path');

    const directory = bound?.config.workspace_root ?? environment.cwd ?? host.workspace;
    const cwd = await realpath(directory).catch(() => host.workspace);
    await connectionExecutable({ config: { file: found.file, canonical_file: found.canonicalFile } }, cwd, host.dataRoot);

    const runOne = async probeArgs => {
      if (!nativeProbeArgs(probeArgs)) reject('invalid_arguments', 'Inspect arguments must be bounded strings');
      const result = await inspectNative(found.canonicalFile, probeArgs, cwd, {
        signal: context.signal, timeoutMs: INSPECT_TIMEOUT_MS,
      });
      return {
        args: result.args,
        exitCode: result.exitCode ?? null,
        exitSignal: result.exitSignal ?? null,
        ...(result.error ? { error: result.error } : {}),
        ...(result.timeout ? { timeout: true } : {}),
        ...(result.interrupted ? { interrupted: true } : {}),
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(result.stderr),
      };
    };

    const observations = [];
    if (args.args !== undefined) {
      observations.push({ purpose: 'custom', ...(await runOne(args.args)) });
    } else {
      const versionArgs = found.name === 'ssh' ? ['-V'] : ['ffmpeg', 'ffprobe', 'ffplay'].includes(found.name) ? ['-version'] : ['--version'];
      const helpArgs = found.name === 'ssh' ? ['-?'] : ['ffmpeg', 'ffprobe', 'ffplay'].includes(found.name) ? ['-h'] : ['--help'];
      const topic = args.help_topic || definition?.helpTopic;
      const [versionRes, helpRes, topicRes] = await Promise.all([
        runOne(versionArgs),
        runOne(helpArgs),
        topic ? runOne([topic, '--help']) : null,
      ]);
      observations.push({ purpose: 'version', ...versionRes }, { purpose: 'help', ...helpRes });
      if (topicRes) observations.push({ purpose: 'topic_help', ...topicRes });
    }
    if (args.diagnostic_args !== undefined) {
      observations.push({ purpose: 'diagnostic', ...(await runOne(args.diagnostic_args)) });
    }

    const versionObs = observations.find(item => item.purpose === 'version');
    const helpObs = observations.find(item => item.purpose === 'help');
    const topicObs = observations.find(item => item.purpose === 'topic_help');
    const versionText = (versionObs?.stdout || versionObs?.stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 240) || '';
    const helpText = [helpObs?.stdout, helpObs?.stderr].filter(Boolean).join('\n');
    const topicHelpText = [topicObs?.stdout, topicObs?.stderr].filter(Boolean).join('\n');

    if (bound) platform.calls.bind(call.id, { target: { kind: 'connection', id: bound.id } });
    return {
      environment: { ...environment, cwd },
      found,
      connection: bound,
      observed: {
        status: 'observed',
        cwd,
        version: versionText,
        help: helpText,
        topic: args.help_topic || definition?.helpTopic || null,
        topic_help: topicHelpText,
        observations,
      },
    };
  }

  async nativeConfig(proposed, protocol, context, previous) {
    if (Object.hasOwn(proposed, 'version'))
      reject('invalid_connection', 'Use config.detected_version to save the observed CLI version');
    if (Object.hasOwn(proposed, 'detected_version') && (typeof proposed.detected_version !== 'string' || !proposed.detected_version.trim()))
      reject('invalid_connection', 'Set config.detected_version to a non-empty version string');
    const filtered = Object.fromEntries(Object.entries(proposed).filter(([key]) => key !== 'probe'));
    let config = { ...previous?.config, ...filtered };
    if (typeof config.file !== 'string' || !isAbsolute(config.file) || Object.keys(filtered).some(key => !nativeKeys.includes(key)))
      reject('invalid_connection', 'Specify an absolute executable and supported native settings');
    const found = await localExecutable(config.file);
    config = { ...config, file: found.file, canonical_file: found.canonicalFile,
      ...(!previous && filtered.allow_arguments === undefined ? { allow_arguments: protocol === 'cli' && !config.adapter && !config.methods?.length } : {}) };
    await connectionExecutable({ config }, this.platform.dataRoot, this.platform.dataRoot);
    if (filtered.workspace_root !== undefined) {
      const workspace = this.platform.workspace(config.workspace_root, context);
      config.workspace_root = workspace.path;
      config.workspace_write = config.workspace_write !== false && workspace.write;
    }
    if (protocol === 'ssh') {
      if (found.name.toLowerCase() !== 'ssh' || programName(found.canonicalFile) !== 'ssh')
        reject('invalid_ssh_binding', 'Choose the approved OpenSSH client executable');
      config.ssh = sshBinding(config.ssh);
    } else if (config.ssh !== undefined) reject('invalid_ssh_binding', 'Choose the SSH protocol to bind a remote target');
    if (filtered.methods !== undefined) {
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
      const workspace = config.workspace_root ? this.platform.workspace(config.workspace_root, context) : null;
      config = { ...config, canonical_command: command.canonicalFile, ...(workspace ? { workspace_root: workspace.path } : {}), workspace_write: true };
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
    if (previous && !sameBinding(previous, entry))
      reject('connection_binding_conflict', 'Update methods on the same connection binding', 409);
  }

  async register(args, context, setup, call, previous) {
    const { protocol } = args;
    if (!protocol || !plain(args.config) || args.adapter || args.connection && (!previous || protocolOf(previous) !== protocol))
      reject('invalid_connection', 'Submit protocol and config for the actual binding');
    const kind = protocol === 'ssh' ? 'cli' : protocol;
    if (['cli', 'codex'].includes(protocol) && args.target && !canInspectHere(this.environment(args, context)))
      reject('environment_unobserved', 'Use authorization from the actual execution host');
    const config = ['cli', 'codex'].includes(kind) ? await this.nativeConfig(args.config, protocol, context, previous)
      : await this.serviceConfig({ ...previous?.config, ...args.config }, protocol, context);
    if (!bindingOf({ kind, config })) reject('invalid_connection', 'Specify the actual execution binding');
    const name = args.name?.trim() || previous?.name || basename(config.file ?? config.command ?? '') || config.service_url || config.url;
    if (!name || name.length > 120) reject('invalid_connection', 'Use a connection name of at most 120 characters');
    const priorRunner = previous?.config.adapter?.runner?.id;
    const dependencies = [...new Set([...(previous?.dependencies ?? []).filter(id => id !== priorRunner),
      ...(config.adapter?.runner ? [config.adapter.runner.id] : [])])];
    return this.save({ id: previous?.id ?? call.id, revision: args.revision, kind, name, config, dependencies }, context, call);
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

  save(input, context, call) {
    return this.platform.configureExecutionConnection(input, {
      actor: user,
      sourceActor: context.actor,
      originSpace: context.conversation?.space ?? context.origin?.space ?? null,
      canSeeBinding: entry => this.visible(entry, context),
      beforeConnectionSave: (entry, previous) => {
        this.platform.assertRunAllowed(context);
        this.assertWrite(entry, previous, context);
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
      this.platform.calls.finish(call.id, 'completed', result);
    });
  }
}
