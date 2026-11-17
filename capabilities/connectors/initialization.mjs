import { readFile } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { idOf, reject, user } from '../platform/contract.mjs';
import { connectionExecutable } from '../services/connection-launch.mjs';
import { canSupplyProcessArguments, connectionRecords } from '../services/connection-records.mjs';
import { allowsExecutable } from '../services/executable-scope.mjs';
import { localExecutable } from '../services/native-host.mjs';
import { observeNativeProbe, visibleProbe } from '../services/native-probe.mjs';
import { connectorFor, connectors } from './registry.mjs';
import { ConnectionOnboarding, executionEnvironment } from './onboarding.mjs';

const windows = process.platform === 'win32';
const guide = new URL('../../skills/summon-execution-onboarding/SKILL.md', import.meta.url);
const release = new URL('../../release.json', import.meta.url);
export const executionGuide = async () => ({ path: fileURLToPath(guide),
  version: JSON.parse(await readFile(release, 'utf8')).version, text: await readFile(guide, 'utf8') });
const pageText = (text, offset = 0) => ({ text: text.slice(offset, offset + 12_000),
  next_offset: offset + 12_000 < text.length ? offset + 12_000 : null });
const names = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,119}$/;
const description = name => `${name} execution through a locally installed CLI`;

async function fetchGuide(url, signal, offset) {
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  if (!response.ok) return { available: false, source: url, status_code: response.status };
  const text = await response.text();
  return { available: true, source: url, ...pageText(text, offset) };
}

export class ConnectionInitializer {
  constructor(platform) {
    this.platform = platform;
    this.onboarding = new ConnectionOnboarding(platform);
  }

  async locate({ command, executable }, definition, setup) {
    const { dataRoot } = this.platform;
    const scopedPaths = setup.executables;
    const name = command || definition?.command;
    if (executable !== undefined && !isAbsolute(executable) || name && !names.test(name))
      reject('invalid_executable', 'Use a command name or an absolute path to an installed executable');
    const roots = [...new Set((process.env.PATH || '').split(delimiter).filter(isAbsolute))];
    const direct = name && windows ? [`${name}.exe`, `${name}.com`] : [name];
    const shims = name && windows ? [`${name}.cmd`, `${name}.bat`, `${name}.ps1`] : [];
    const inPath = files => files[0] ? roots.flatMap(root => files.map(file => join(root, file))) : [];
    const matchesCommand = path => windows ? basename(path, extname(path)).toLowerCase() === name?.toLowerCase() : basename(path) === name;
    const candidates = executable ? [executable] : scopedPaths ? scopedPaths.map(item => item.file).filter(matchesCommand) :
      [...inPath(direct), ...(await definition?.candidates(roots) || []), ...inPath(shims)];
    for (const file of new Set(candidates)) {
      try {
        const found = await localExecutable(file);
        if (!allowsExecutable(scopedPaths, found.canonicalFile)) continue;
        await connectionExecutable({ config: { file, canonical_file: found.canonicalFile } }, dataRoot, dataRoot);
        return found;
      } catch (error) {
        if (executable && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      }
    }
    return null;
  }

  probe(found, definition, args, context, options) {
    return observeNativeProbe({ file: found.canonicalFile, name: found.name, cwd: this.platform.connections.workspace,
      topic: args.help_topic || definition?.helpTopic, diagnosticArgs: args.diagnostic_args, signal: context.signal, ...options });
  }

  managed(context) {
    const host = this.platform.connections;
    return this.platform.store.list(connectionRecords).filter(entry => this.platform.repairableConnection(entry, context) &&
      host.authorized(entry, context.actor));
  }

  setupOwns(entry, context, setup) {
    if (!entry || !['codex', 'cli'].includes(entry.kind) || entry.config.initialized_for !== context.actor.id ||
        !this.platform.canUseConnection(context.actor, entry.id, context) || !this.platform.connections.authorized(entry, context.actor)) return false;
    const workspace = setup.workspace && this.platform.workspace(setup.workspace, context);
    return workspace ? Boolean(entry.config.workspace_root && samePath(workspace.path, entry.config.workspace_root)) : !entry.config.workspace_root;
  }

  async grantAccess(args, context, setup, call, entry) {
    const host = this.platform.connections;
    if (setup.repair || !this.setupOwns(entry, context, setup))
      reject('connection_forbidden', 'Grant access within the current host-authorized CLI setup', 403);
    const bot = this.platform.getBot(idOf(args.bot, 'bot'));
    const actor = { kind: 'bot', id: bot.id };
    if (!this.platform.manager.canConfigure(context.actor, bot))
      reject('configuration_forbidden', 'Choose a Bot you can configure', 403);
    if (!['use', 'repair'].includes(args.access)) reject('invalid_arguments', 'Specify use or repair access');
    if (args.revision !== entry.revision) reject('revision_conflict', 'Connection settings changed', 409, { revision: entry.revision });
    const allowed_bot_ids = [...new Set([...entry.allowed_bot_ids, bot.id])];
    const repair_bot_ids = [...new Set([...(entry.repair_bot_ids || []), ...(args.access === 'repair' ? [bot.id] : [])])];
    if (!host.authorized({ ...entry, allowed_bot_ids }, actor))
      reject('dependency_access_required', 'The Bot needs its own grants for the required CLI dependencies', 403);
    const complete = result => {
      this.platform.calls.bind(call.id, { target: { kind: 'connection', id: entry.id } });
      return this.platform.calls.finish(call.id, 'completed', { ...result, bot: actor, access: args.access });
    };
    if (allowed_bot_ids.length === entry.allowed_bot_ids.length && repair_bot_ids.length === (entry.repair_bot_ids?.length ?? 0))
      return complete({ ...host.clean(host.summary(entry), []), ...this.platform.connectionMaintenance(entry) });
    return this.platform.configureExecutionConnection({ id: entry.id, revision: args.revision, allowed_bot_ids, repair_bot_ids },
      { actor: user, initializer_id: context.actor.id }, complete);
  }

  async run(args, context, setup, call) {
    const { action, offset } = args;
    const connectionId = args.connection && idOf(args.connection, 'connection');
    const selected = setup.connection || (connectionId && this.managed(context).find(item => item.id === connectionId));
    const selectedConnector = selected && connectorFor(selected.config.setup_key || selected.config.adapter?.connector ||
      (selected.kind === 'codex' ? 'codex' : null))?.id;
    const connector = args.connector || selectedConnector;
    const definition = connector && connectorFor(connector);
    const host = this.platform.connections;
    if (action === 'assign_maintainer') return this.platform.assignMaintainer(args, context, call);
    if (action === 'upsert_method') return this.onboarding.upsert(args, context, call, selected);
    if (action === 'register') {
      if (args.protocol) return this.onboarding.register(args, context, setup, call, selected);
      if (args.config !== undefined) reject('invalid_connection', 'Specify protocol when supplying config. For an existing CLI version update, use protocol:"cli", connection, revision and config.detected_version');
    }
    if (setup.repair && selected && (args.connector && args.connector !== selectedConnector ||
        args.executable && !samePath(args.executable, selected.config.file)))
      reject('connection_binding_conflict', 'Repair stays on the registered connector and executable', 409);
    if (action === 'grant_access') return this.grantAccess(args, context, setup, call, selected);
    if (connector && !definition) reject('connector_not_found', 'The built-in connector is unavailable', 404);
    if (action === 'guide') {
      const { text, ...reference } = await executionGuide();
      return { connector, ...reference, ...pageText(text, offset),
        ...(definition ? { connector_notes: await readFile(definition.guide, 'utf8') } : {}) };
    }
    if (action === 'source') {
      if (args.connection) {
        if (!selected) reject('connection_forbidden', 'This connection is outside the Pi initializer’s authority', 403);
        const adapter = selected.config.adapter;
        return host.clean({ ...(adapter?.source !== undefined ? { ...pageText(adapter.source, offset), runner: adapter.runner.id } :
          adapter?.recipe ? { recipe: adapter.recipe } : definition ? pageText(await readFile(definition.source, 'utf8'), offset) :
            await host.read(selected.id, this.platform.connectionContext(context))),
          ...(selected.config.launch_arguments ? { arguments: selected.config.launch_arguments } : {}),
          ...(selected.config.probe ? { probe: visibleProbe(selected.config.probe),
            ...(selected.config.probe.script?.source !== undefined ?
              { probe_script: pageText(selected.config.probe.script.source, offset) } : {}) } : {}),
          ref: { kind: 'connection', id: selected.id } });
      }
      if (!definition) reject('connector_required', 'Choose a connector or a managed connection');
      return { connector, ...pageText(await readFile(definition.source, 'utf8'), offset) };
    }
    if (action === 'documentation') {
      if (!definition) reject('connector_required', 'Choose a connector to look up its official documentation');
      try { return await fetchGuide(definition.documentation, context.signal, offset); }
      catch { return { available: false, source: definition.documentation }; }
    }
    if (action === 'discover') {
      if (setup.onboarding || args.query || args.command || args.executable || args.target || args.workspace)
        return this.onboarding.discovery(args, context, setup);
      const items = setup.repair ? [] : await Promise.all(connectors.map(async item => ({ id: item.id, name: item.name, command: item.command,
        executable: (await this.locate({}, item, setup))?.file ?? null })));
      return { environment: executionEnvironment(), items, ...(setup.executables ? { authorized_executables: setup.executables.map(item => item.file) } : {}),
        ...(setup.workspace ? { workspace: this.platform.workspace(setup.workspace, context) } : {}),
        managed: (setup.connections ?? this.managed(context)).map(entry => ({ ...host.summary(entry), ...this.platform.connectionMaintenance(entry),
          file: entry.config.file, connector: entry.config.adapter?.connector ?? entry.config.setup_key, resume: entry.config.adapter?.resume,
          custom: Boolean(entry.config.adapter?.recipe || entry.config.adapter?.source), workspace_root: entry.config.workspace_root })) };
    }
    if (action === 'inspect' && (!setup.hostSetup || args.target || args.connection || args.probe || args.diagnostic_args)) {
      const result = await this.onboarding.inspect(args, context, setup, this, definition, selected, call);
      if (!result.found) return result;
      const { found, observed, environment, connection, maintenance } = result;
      return host.clean({ ...observed, available: true, environment, connector, file: found.file, canonical_file: found.canonicalFile,
        ...(connection ? { connection: { kind: 'connection', id: connection.id }, revision: connection.revision } : {}),
        ...(maintenance ? { maintenance } : {}),
        help: pageText(observed.help, offset), topic_help: pageText(observed.topic_help, offset),
        ...(definition ? { settings: definition.settings(observed.help, observed.topic_help),
          argument_overrides: { reserved: definition.protocolOptions, current: selected?.config.launch_arguments ?? {} } } : {}) });
    }
    if (!definition && !args.command && !args.executable && !selected) reject('executable_required', 'Choose a connector, command or executable path');
    const target = selected && (setup.repair || !args.executable) ? { executable: selected.config.file } : args;
    const found = await this.locate(target, definition, setup);
    if (!found) return { available: false, connector, reason: 'The executable was not found in this initialization scope' };
    this.platform.requireConnectionSetup(context, args);
    const observation = await this.probe(found, definition, args, context);
    const settings = definition?.settings(observation.help, observation.topic_help);
    if (action === 'inspect') return host.clean({ ...observation, available: true, connector, file: found.file, canonical_file: found.canonicalFile,
      help: pageText(observation.help, offset), topic_help: pageText(observation.topic_help, offset), settings,
      ...(definition ? { argument_overrides: { reserved: definition.protocolOptions, current: selected?.config.launch_arguments ?? {} } } : {}) });
    const raw = selected?.kind === 'cli' && !selected.config.adapter;
    if (raw && args.adapter) reject('connection_binding_conflict', 'Use host connection settings to replace the raw CLI input contract', 409);
    if (!definition && !args.adapter && !selected) reject('adapter_required', 'Supply an adapter for the inspected CLI');
    if (args.adapter?.arguments && !definition) reject('invalid_adapter', 'Argument overrides require an installed built-in connector');
    if (setup.executables === undefined && args.adapter) {
      const installed = definition && await this.locate({}, definition, setup);
      const existing = this.platform.store.list(connectionRecords).some(entry => entry.kind === 'cli' &&
        entry.config.canonical_file && samePath(entry.config.canonical_file, found.canonicalFile) &&
        this.platform.canUseConnection(context.actor, entry.id, context) && host.authorized(entry, context.actor) &&
        canSupplyProcessArguments(entry, context.actor));
      if (!(installed && samePath(installed.canonicalFile, found.canonicalFile)) && !existing)
        reject('executable_scope_forbidden', 'Use an executable selected by the host or an existing native argument grant', 403);
    }
    return this.register({ args, found, definition, selected, raw, version: observation.version, settings, setup, call, context });
  }

  async register({ args, found, definition, selected, raw, version, settings, setup, call, context }) {
    const host = this.platform.connections;
    const custom = args.adapter?.recipe || args.adapter?.source !== undefined;
    const argumentOverrides = args.adapter?.arguments;
    const kind = custom ? 'cli' : selected?.kind ?? definition.kind;
    const setupKey = raw ? selected.config.setup_key : definition?.id || found.name;
    const current = args.connection && idOf(args.connection, 'connection');
    const scopedWorkspace = !setup.repair && setup.workspace && this.platform.workspace(setup.workspace, context);
    const matchesScope = entry => setup.repair || (scopedWorkspace && entry.config.workspace_root ? samePath(scopedWorkspace.path, entry.config.workspace_root) :
      (!scopedWorkspace && !entry.config.workspace_root));
    const matchesConnector = entry => entry.config.setup_key === setupKey && entry.kind === kind &&
      samePath(entry.config.canonical_file, found.canonicalFile) && matchesScope(entry);
    const owned = this.managed(context).filter(entry => setup.repair || entry.config.initialized_for === context.actor.id);
    const previous = current ? owned.find(entry => entry.id === current && matchesScope(entry)) : owned.find(matchesConnector);
    if (current && !previous) reject('connection_forbidden', 'The existing connection is outside this Bot’s initialization authority', 403);
    if (previous && previous.kind !== kind) reject('connection_binding_conflict', 'Use a new connection when replacing the protocol', 409);
    if (previous && !samePath(previous.config.canonical_file, found.canonicalFile))
      reject('connection_binding_conflict', 'The selected connection is bound to another executable', 409);
    if (current && args.revision !== previous.revision) reject('revision_conflict', 'Connection settings changed', 409, { revision: previous.revision });
    const name = args.name?.trim() || previous?.name || definition?.name || found.name;
    if (name.length > 120) reject('invalid_connection', 'Use a connection name of at most 120 characters');
    const id = previous?.id ?? call.id;
    const config = { ...previous?.config,
      ...(!setup.repair ? { file: found.file, canonical_file: found.canonicalFile } : {}),
      ...(!previous ? { allow_arguments: false, initialized_for: context.actor.id } : {}),
      ...(setupKey ? { setup_key: setupKey } : {}), detected_version: version || previous?.config.detected_version,
      ...(scopedWorkspace ? { workspace_root: scopedWorkspace.path, workspace_write: scopedWorkspace.write } : {}) };
    if (definition && !raw && !custom && (argumentOverrides || previous?.config.adapter?.source === undefined && !previous?.config.adapter?.recipe))
      Object.assign(config, definition.config ? definition.config(settings) : {
        adapter: { connector: definition.id, settings, resume: settings.resume && settings.format !== 'plain' },
      });
    if (argumentOverrides) config.launch_arguments = { ...previous?.config.launch_arguments, ...argumentOverrides };
    if (custom) delete config.launch_arguments;
    if (args.adapter?.recipe) config.adapter = { connector: definition?.id, recipe: args.adapter.recipe, resume: Boolean(args.adapter.recipe.resume_args) };

    if (args.adapter?.source !== undefined) {
      const { source, resume } = args.adapter;
      const runnerId = idOf(args.adapter.runner, 'connection');
      const runner = host.get(runnerId);
      if (runner?.kind !== 'cli' || runner.config.adapter || runnerId === id ||
          !host.authorized(runner, context.actor) || !canSupplyProcessArguments(runner, context.actor) ||
          !allowsExecutable(setup.executables, runner.config.canonical_file) || setup.repair && runnerId !== previous?.config.adapter?.runner?.id)
        reject('script_runner_forbidden', 'Use the existing native runner and direct argument grant for this Pi', 403);
      await connectionExecutable(runner, host.dataRoot, host.dataRoot);
      const live = host.get(runnerId);
      if ((live?.binding_version ?? 1) !== (runner.binding_version ?? 1) || !host.authorized(live, context.actor))
        reject('connection_binding_changed', 'The native runner grant changed during initialization', 409);
      config.adapter = { connector: definition?.id, resume: resume === true, source,
        runner: { id: runnerId, binding_version: runner.binding_version ?? 1 } };
    }
    this.platform.requireConnectionSetup(context, args);
    if (!previous && this.managed(context).some(entry => entry.config.initialized_for === context.actor.id && matchesConnector(entry)))
      reject('revision_conflict', 'Another initialization registered this connector', 409);
    const previousRunner = previous?.config.adapter?.runner?.id;
    const dependencies = [...new Set([...(previous?.dependencies || []).filter(id => id !== previousRunner),
      ...(config.adapter?.runner ? [config.adapter.runner.id] : [])])];
    return this.platform.configureExecutionConnection({ id, revision: previous?.revision, kind, name,
      description: previous?.description ?? description(name), config, dependencies, ...(!previous ? { allowed_bot_ids: [context.actor.id] } : {}) },
    { actor: user, initializer_id: context.actor.id,
      canSeeBinding: entry => this.platform.canUseConnection(context.actor, entry.id, context),
      beforeConnectionSave: () => this.platform.requireConnectionSetup(context, args) }, result => {
      this.platform.calls.bind(call.id, { target: { kind: 'connection', id: result.id } });
      this.platform.calls.finish(call.id, 'completed', result);
    });
  }
}
