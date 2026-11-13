import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { assertPathPolicy, createPathAccess, fileAccessDenied, insideProtectedDirectory, resolveFilePath, samePath, sensitivePath } from '../../bot/src/capabilities/file-policy.mjs';
import { taskFileAccessPolicy } from '../../bot/src/capabilities/file-access.mjs';
import { currentUserRequest } from '../../bot/src/capabilities/request-routing.mjs';
import { acceptedWorkTask, taskSource, workExecution } from '../../bot/src/context/sources.mjs';
import { fail, now, required, safeId } from '../shared/validation.mjs';
import { discoverExecutables, executableKey, findExecutable, inspectNative, installedExecutablePath, localExecutable, nativeArgs, nativeCommand, nativeEnvironment } from './native-host.mjs';
import { checkedNativeArguments, hasExplicitFileScope, inspectOnlyArgs, nativeFileArgs, validInspectionArgs } from './native-file-arguments.mjs';
import { NativeExecutions, liveNative } from './native-executions.mjs';
import { NativeSources } from './native-sources.mjs';

const entries = 'catalog-entries';
const observations = 'native-observations';
const candidates = 'native-discovery';
const tasks = 'native-maintenance';
const schedules = 'native-observation-schedules';
const stopped = new Set(['paused', 'cancelled', 'completed']);
const ambientMaintenance = new Set(['version-change', 'version-check-failed', 'executable-unavailable', 'path-change', 'scheduled-change', 'scheduled-failure']);
const recurringMaintenance = new Set(['scheduled-change', 'scheduled-failure', 'display-failure', 'connection-failure']);
const remoteProjection = receipt => JSON.stringify([receipt.status, receipt.reconciledAt || null]);
const invocationIdentity = ({ id, methodId, parameters, args, cwd, input, keepInput, resumeFromOperationId, recoveryBindingId, effect, fileArgs }) =>
  ({ id, methodId, parameters, args, cwd, input, keepInput, resumeFromOperationId, recoveryBindingId, effect, fileArgs });
const scopeStatus = status => status === 'completed' || status === 'failed' || status === 'stopped' || status === 'unknown';
const stamp = file => [executableKey(file.canonicalFile), file.size, file.modifiedAt].join('|');
const currentMethod = (entry, id) => entry.native?.methods?.find(method => method.id === id && method.resourceRevision === entry.native.resourceRevision);
const requireRevision = (entry, revision) => {
  if (entry.revision !== revision) fail('Resource changed; read the current catalog entry before editing', 409);
};
const protocolGuide = 'Bridge stdout uses one JSON object per line: {"summonEvent":{"type":"session","sessionId":"..."}}; progress/result use text; request uses id,text,kind (question/approval/login), choices [{id,label}]; resolved/withdrawn use id. stdin receives {"summonInput":{"type":"message/answer/stop","id":"...","requestId":"...","text":"..."}}. Emit resolved only after the real protocol accepts the answer. Retain real native session IDs for future resume. Never emit credentials.';

function expand(value, parameters, preserveType = false) {
  if (typeof value === 'string' && preserveType) {
    const exact = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(value);
    if (exact) {
      if (!Object.hasOwn(parameters, exact[1])) fail('Missing method parameter: ' + exact[1]);
      return parameters[exact[1]];
    }
  }
  if (typeof value === 'string') return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(parameters, key) || !['string', 'number', 'boolean'].includes(typeof parameters[key])) fail('Missing or invalid method parameter: ' + key);
    return String(parameters[key]);
  });
  if (Array.isArray(value)) return value.map(item => expand(item, parameters, preserveType));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, parameters, preserveType)]));
  return value;
}

export class NativeToolService {
  constructor({ catalog, manager, store, dataRoot, workspace, emit, notifyUser, readArchive }) {
    Object.assign(this, { catalog, manager, store, dataRoot, workspace, emit, notifyUser, readArchive });
    this.host = store.get('native-hosts', 'local') || store.save('native-hosts', { id: 'local', hostId: randomUUID(), name: hostname(), platform: process.platform, architecture: process.arch });
    this.executions = new NativeExecutions({ store, dataRoot, emit, clean: value => catalog.clean(value) });
    this.sources = new NativeSources(this);
    this.working = new Map();
  }

  entry(id, actor) {
    const entry = this.catalog.entry(id);
    this.catalog.access(entry, actor);
    if (entry.kind === 'skill') fail('Use the underlying tool resource for native actions');
    return entry;
  }
  owner(id, actor) {
    const entry = this.entry(id, actor);
    this.catalog.owner(entry, actor);
    return entry;
  }
  forHost() { return this.store.list(entries).filter(entry => entry.kind === 'cli' && entry.native?.hostId === this.host.hostId); }
  matches(file) {
    const key = executableKey(file.canonicalFile);
    return this.forHost().find(entry => executableKey(entry.config.canonicalFile) === key || entry.native.installations?.some(item => executableKey(item.canonicalFile) === key));
  }
  save(entry, native, patch = {}) {
    const current = this.catalog.entry(entry.id);
    return this.store.save(entries, { ...current, ...patch, id: entry.id, native: { ...current.native, ...native } });
  }

  ownsDelegation(entry, actor, workId) {
    return entry?.ownerBotId === actor && this.store.list('catalog-delegations').some(record =>
      record.entryId === entry.id && record.ownerBotId === actor && record.ownerWorkId === workId);
  }

  async workContext(actor, task, args = {}, { discovery = false, inspectionEntry } = {}) {
    if (actor === 'controller') return { cwd: this.workspace };
    const config = await this.manager.config(actor);
    const saved = task && await this.manager.readState(actor, db => {
      const work = task.workId && db?.getRecord('works', task.workId);
      const execution = work && workExecution(task, db);
      return { work, execution, policy: db ? taskFileAccessPolicy(task, db, work?.project?.cwd || config.workspace) : {} };
    });
    if (!discovery && (!saved?.work || !saved.execution?.authorization?.source || stopped.has(saved.work.status)))
      fail('An active original work and its accepted authority are required', 409);
    if (args.workId && args.workId !== saved?.work?.id) fail('Use the current original work', 403);
    const workProject = saved?.work?.project?.cwd || config.workspace;
    // Help and version probes use the maintainer's workspace. The work's file
    // policy still uses its recorded project to resolve relative restrictions.
    const project = this.ownsDelegation(inspectionEntry, actor, saved?.work?.id) ? config.workspace : workProject;
    const checkedPath = createPathAccess({ workspace: config.workspace, project, base: project,
      protectedDirectories: [this.dataRoot], accessPolicy: saved?.policy });
    const cwd = await checkedPath(args.cwd || '.', { directory: true, operations: !discovery && args.cwd ? ['read', 'write'] : ['read'], alternative: true });
    return { ...saved, cwd, checkedPath, config, source: saved?.execution?.authorization?.source };
  }

  protectedExecutable(path, workspace = this.workspace) {
    return sensitivePath(path, workspace) || insideProtectedDirectory(path, workspace, [this.dataRoot]);
  }

  async executablePath(file, scope, actor, entry, { canonical = false, catalogMethod = false } = {}) {
    const requested = resolveFilePath(scope.cwd, file);
    const operations = ['execute'];
    if (this.protectedExecutable(requested, scope.config?.workspace)) throw fileAccessDenied(requested, 'protected_path', { operations });
    assertPathPolicy(requested, scope.policy, { operations, alternative: !canonical });
    if (actor !== 'controller') {
      const maintenance = this.ownsDelegation(entry, actor, scope.work?.id);
      const registered = catalogMethod && scope.work && entry?.native?.hostId === this.host.hostId &&
        entry.native.executableAuthority?.some(record => record.actor === actor &&
          samePath(record.file, requested) && samePath(record.canonicalFile, entry.config.canonicalFile));
      try { await scope.checkedPath(requested, { file: true, operations, alternative: !canonical }); }
      catch (error) {
        if (error.accessDenial?.reason !== 'outside_allowed_roots' || !maintenance && !registered && !installedExecutablePath(requested)) throw error;
      }
    }
    const actual = await localExecutable(requested);
    if (this.protectedExecutable(actual.canonicalFile, scope.config?.workspace))
      throw fileAccessDenied(requested, 'resolved_protected_path', { operations });
    assertPathPolicy(actual.canonicalFile, scope.policy, { operations, alternative: !canonical });
    if (entry && !samePath(entry.config.canonicalFile, actual.canonicalFile))
      throw fileAccessDenied(requested, 'executable_binding_changed', { operations });
    return actual;
  }

  async discover(args, actor, task) {
    const scope = await this.workContext(actor, task, args, { discovery: true });
    const command = args.command;
    const direct = command && (isAbsolute(command) || /[/\\]/.test(command) ?
      await this.executablePath(command, scope, actor, null, { canonical: true }) :
      await this.executablePath((await findExecutable(command, scope.cwd)).file, scope, actor, null, { canonical: true }));
    let results;
    if (direct) results = [{ ...direct, aliases: [direct.name], source: 'explicit' }];
    else {
      const cached = this.discovery;
      if (cached?.cwd === scope.cwd && Date.now() < cached.expires) results = await cached.promise;
      else {
        this.discovery = { cwd: scope.cwd, expires: Date.now() + 60_000, promise: discoverExecutables(scope.cwd) };
        results = await this.discovery.promise;
      }
    }
    results = results.filter(file => !this.protectedExecutable(file.file, scope.config?.workspace) &&
      !this.protectedExecutable(file.canonicalFile, scope.config?.workspace));
    const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = results.filter(file => terms.every(term => [file.file, ...file.aliases].some(text => text.toLowerCase().includes(term))));
    const offset = Math.min(args.offset || 0, filtered.length), limit = Math.min(args.limit || 24, 100);
    const prior = new Map(this.store.list(candidates).map(item => [executableKey(item.canonicalFile), item]));
    const rows = filtered.slice(offset, offset + limit).map(file => {
      const before = prior.get(executableKey(file.canonicalFile));
      const known = this.matches(file);
      const allowedActors = [...new Set([...(before?.allowedActors || []), actor])];
      const row = this.store.save(candidates, { ...file, id: before?.id || randomUUID(), allowedActors, observedAt: now() });
      const { allowedActors: actors, ...value } = row;
      return { ...value, resourceId: known?.id, ownerBotId: known?.ownerBotId, status: known?.native?.status };
    });
    const nextOffset = offset + limit < filtered.length ? offset + limit : null;
    const scan = { id: randomUUID(), kind: command ? 'single' : terms.length ? 'filtered' : 'full',
      total: filtered.length, offset, nextOffset, observedAt: now(), taskId: task?.id };
    if (task?.workId) this.store.transaction(() => {
      const id = JSON.stringify([actor, task.workId]);
      const previous = this.store.get('native-discovery-runs', id);
      this.store.save('native-discovery-scans', this.catalog.clean({ ...scan, actor, workId: task.workId,
        cwd: scope.cwd, command: command || null, query: args.query || null }));
      this.store.save('native-discovery-runs', { id, scans: { ...previous?.scans, [scan.kind]: scan } });
    });
    if (scan.kind === 'full') this.store.save('native-hosts', { id: 'local', lastDiscovery: { at: scan.observedAt, total: scan.total, cwd: scope.cwd } });
    return { host: this.host, candidates: rows, total: scan.total, nextOffset, scan };
  }

  async enroll(args, actor, task) {
    const candidate = this.store.get(candidates, safeId(args.candidateId));
    if (!candidate || actor !== 'controller' && !candidate.allowedActors.includes(actor)) fail('Discover this candidate first', 404);
    const context = await this.workContext(actor, task);
    const file = await this.executablePath(candidate.file, context, actor);
    if (!samePath(candidate.canonicalFile, file.canonicalFile)) fail('The observed executable path changed; discover the current entry again', 409);
    const origin = context.policy?.grants?.find(grant => grant.operations.includes('execute') && samePath(grant.path, file.file));
    const authority = origin && { actor, file: file.file, canonicalFile: file.canonicalFile,
      sourceTaskId: origin.sourceTaskId, sourceMessageId: origin.sourceMessageId, sourceRoomId: origin.sourceRoomId };
    return this.catalog.serial('native-enroll', async () => {
      let entry = this.matches(file);
      if (!entry) {
        const sameName = this.forHost().filter(item => item.config.executableName === file.name);
        const moved = (await Promise.all(sameName.map(async item => !await localExecutable(item.config.file).catch(() => null) ? item : null))).filter(Boolean);
        if (moved.length === 1) entry = moved[0];
      }
      if (!entry) {
        const id = 'cli-' + randomUUID(), name = args.name || file.name;
        await this.catalog.save({ id, kind: 'cli', name, description: args.description || 'Local command-line tool ' + file.name,
          config: { file: file.file, canonicalFile: file.canonicalFile, executableName: file.name }, allowedBotIds: ['*'],
          source: { type: 'native-discovery', candidateId: candidate.id, at: candidate.observedAt, path: file.file },
          native: { hostId: this.host.hostId, resourceRevision: 1, status: 'discovered', installations: [file], aliases: candidate.aliases,
            fingerprint: stamp(file), versionArgs: ['--version'], methods: [], ...(authority ? { executableAuthority: [authority] } : {}) },
        }, actor, { native: true, ownerModel: context.config?.model });
        entry = this.catalog.entry(id);
        this.observation(entry, 'discovery', { file, candidateId: candidate.id, source: candidate.source }, actor);
      } else if (!await localExecutable(entry.config.file).catch(() => null) && executableKey(entry.config.canonicalFile) !== executableKey(file.canonicalFile)) {
        const previous = entry.config.file;
        entry = this.save(entry, { installations: [...(entry.native.installations || []), file], fingerprint: stamp(file), version: null,
          resourceRevision: entry.native.resourceRevision + 1, status: 'changed' },
        { config: { ...entry.config, file: file.file, canonicalFile: file.canonicalFile }, revision: entry.revision + 1 });
        const observation = this.observation(entry, 'path-change', { previous, current: file.file }, actor);
        this.enqueue(entry, 'path-change', observation, actor, task);
      } else if (candidate.aliases?.some(alias => !entry.native.aliases?.includes(alias))) {
        entry = this.save(entry, { aliases: [...new Set([...(entry.native.aliases || []), ...candidate.aliases])] });
      }
      if (authority && !entry.native.executableAuthority?.some(item => item.actor === actor && samePath(item.file, file.file) &&
        samePath(item.canonicalFile, file.canonicalFile)))
        entry = this.save(entry, { executableAuthority: [...(entry.native.executableAuthority || []), authority] });
      if (!currentMethod(entry, entry.native.methods?.find(method => method.resourceRevision === entry.native.resourceRevision)?.id))
        this.enqueue(entry, 'initial-learning', entry.lastObservationId ? this.store.get(observations, entry.lastObservationId) : null, actor, task);
      if (task?.workId) {
        const key = JSON.stringify([actor, task.workId]), prior = this.store.get('native-discovery-runs', key);
        this.store.save('native-discovery-runs', { id: key, resources: [...new Set([...(prior?.resources || []), entry.id])] });
      }
      return this.catalog.get(entry.id, actor);
    });
  }

  observation(entry, type, value, actor = 'controller') {
    const record = this.store.save(observations, this.catalog.clean({ id: randomUUID(), resourceId: entry.id, type, actor,
      revision: entry.revision, resourceRevision: entry.native?.resourceRevision || entry.revision, observedAt: now(), ...value }));
    this.store.save(entries, { id: entry.id, lastObservationId: record.id });
    return record;
  }

  observations(args, actor, task) {
    const entry = this.entry(args.id, actor);
    const delegation = task?.workId && this.store.list('catalog-delegations').find(record => record.ownerBotId === actor &&
      record.ownerWorkId === task.workId && record.entryId === entry.id);
    const scoped = item => !item.workId || actor === 'controller' || item.actor === actor && item.workId === task?.workId ||
      item.actor === delegation?.actor && item.workId === delegation?.sourceWorkId;
    if (args.observationId) {
      const value = this.store.get(observations, args.observationId);
      if (value?.resourceId !== args.id || !scoped(value)) fail('Observation is outside the current source work', 404);
      return value;
    }
    const items = this.store.list(observations).filter(item => item.resourceId === args.id && scoped(item)).reverse();
    const offset = args.offset || 0, limit = Math.min(args.limit || 10, 50);
    return { observations: items.slice(offset, offset + limit).map(({ id, type, observedAt, actor, revision }) => ({ id, type, observedAt, actor, revision })),
      nextOffset: offset + limit < items.length ? offset + limit : null };
  }

  async probe(args, actor, task, signal) {
    const entry = this.owner(args.id, actor);
    if (entry.kind !== 'cli') fail('Use catalog_probe for a network or MCP connection');
    const context = await this.workContext(actor, task, {}, { inspectionEntry: entry });
    const argv = nativeArgs(args.args);
    inspectOnlyArgs(argv);
    return this.catalog.serial('native-resource:' + entry.id, async () => {
      let current = this.catalog.entry(entry.id);
      if (this.executions.forResource(entry.id).some(item => item.effect === 'update' && item.status !== 'queued' && liveNative(item.status)))
        fail('The resource is being updated', 409);
      const file = await this.executablePath(current.config.file, context, actor, current);
      const result = await inspectNative(file.canonicalFile, argv, context.cwd, { signal });
      const version = result.exitCode === 0 && !result.timeout && (result.stdout.trim() || result.stderr.trim()).split('\n')[0].trim().slice(0, 256);
      if (args.versionProbe && version) {
        const changed = current.native.version && current.native.version !== version;
        current = this.save(current, { version, versionArgs: argv, versionObserved: true, status: changed ? 'changed' : current.native.status === 'ready' ? 'ready' : 'inspected',
          lastCheckedAt: result.observedAt, resourceRevision: current.native.resourceRevision + Number(Boolean(changed)) },
        changed ? { revision: current.revision + 1 } : {});
      }
      return { ...this.observation(current, args.versionProbe ? 'version-probe' : 'interface-probe', result, actor), protocolGuide };
    });
  }

  async check(entry, { force = false, actor = 'controller', task, signal, workspace } = {}) {
    if (entry.kind !== 'cli') return entry;
    const original = entry.native;
    const observedFile = await localExecutable(entry.config.file).catch(() => null);
    const file = observedFile && samePath(entry.config.canonicalFile, observedFile.canonicalFile) &&
      !this.protectedExecutable(observedFile.file, workspace) && !this.protectedExecutable(observedFile.canonicalFile, workspace) ? observedFile : null;
    const pathChanged = !file || original.fingerprint !== stamp(file);
    if (!pathChanged && !force && original.lastCheckedAt && Date.now() - Date.parse(original.lastCheckedAt) < 1500) return entry;
    if (!file) {
      if (original.status === 'unavailable') return entry;
      const changed = this.save(entry, { status: 'unavailable', version: null, resourceRevision: original.resourceRevision + 1, lastCheckedAt: now() }, { revision: entry.revision + 1 });
      const observed = this.observation(changed, 'executable-unavailable', { file: entry.config.file, previousVersion: original.version }, actor);
      this.enqueue(changed, 'executable-unavailable', observed, actor, task);
      return changed;
    }
    if (!original.versionObserved && !pathChanged) return entry;
    const result = validInspectionArgs(original.versionArgs) ?
      await inspectNative(file.canonicalFile, original.versionArgs, this.workspace, { signal }) :
      { observedAt: now(), exitCode: null, error: 'The saved version invocation needs a current documented version or help probe.' };
    const text = result.exitCode === 0 && !result.timeout && (result.stdout.trim() || result.stderr.trim()).split('\n')[0].trim().slice(0, 256);
    const changed = pathChanged || Boolean(text && original.version && original.version !== text) || original.status === 'unavailable';
    if (!changed && (text || !original.versionObserved))
      return this.save(entry, { lastCheckedAt: result.observedAt });
    if (!changed && original.status === 'observation-failed') return entry;
    const next = this.save(entry, { fingerprint: stamp(file), version: text || null,
      status: changed ? 'changed' : 'observation-failed', resourceRevision: original.resourceRevision + 1, lastCheckedAt: result.observedAt },
    { revision: entry.revision + 1, config: { ...entry.config, canonicalFile: file.canonicalFile } });
    const kind = changed ? 'version-change' : 'version-check-failed';
    const observed = this.observation(next, kind, { ...result, previousVersion: original.version, version: next.native.version }, actor);
    this.enqueue(next, kind, observed, actor, task);
    return next;
  }

  async methodWrite(args, actor) {
    return this.catalog.serial('native-resource:' + args.id, async () => {
      const entry = this.owner(args.id, actor);
      requireRevision(entry, args.expectedRevision);
      if (!args.sourceIds?.length || args.sourceIds.length > 20) fail('A method needs real observations or operation receipts');
      const revision = entry.native?.resourceRevision || entry.revision;
      let currentEvidence = false;
      for (const id of args.sourceIds) {
        const observation = this.store.get(observations, id);
        const call = this.store.get('catalog-requests', id);
        if (observation?.resourceId !== entry.id && call?.entryId !== entry.id) fail('A method source does not belong to this resource');
        if (observation?.resourceRevision === revision && !observation.error && !observation.timeout && (observation.exitCode === undefined || observation.exitCode === 0) &&
          !['discovery', 'interface-source', 'method-needed'].includes(observation.type)) currentEvidence = true;
      }
      if (!currentEvidence) fail('Read the current version/interface or record an actual call before publishing the method', 409);
      const id = safeId(args.methodId), methods = entry.native?.methods || [], previous = methods.find(method => method.id === id);
      const method = { id, name: required(args.name, 'method name', 128), description: required(args.description, 'method description', 8000),
        resourceRevision: revision, revision: (previous?.revision || 0) + 1, version: entry.native?.version || null, sourceIds: args.sourceIds,
        effect: args.effect || 'write', observedAt: now() };
      if (entry.kind === 'cli') {
        method.args = nativeArgs(args.args);
        method.fileArgs = nativeFileArgs(args.fileArgs, method.args.length, method.effect);
        method.input = args.input;
        method.keepInput = args.keepInput === true;
        method.protocol = args.protocol || 'stdin';
        nativeEnvironment(args.env, entry.native.credentialRefs);
        method.env = args.env;
        if (!method.args.length && !args.script) fail('Provide actual CLI arguments or a native bridge');
        if (method.protocol === 'summon-jsonl' && !method.keepInput) fail('The event bridge needs open stdin');
        if (args.script) {
          this.catalog.safeText(args.script, 128 * 1024);
          const folder = join(this.catalog.skillRoot, entry.id, 'scripts');
          await mkdir(folder, { recursive: true, mode: 0o700 });
          const filename = id + '-' + method.revision + '.mjs';
          await writeFile(join(folder, filename), args.script, { mode: 0o600 });
          method.script = 'scripts/' + filename;
        }
      } else {
        method.tool = required(args.tool, 'registered tool name', 80);
        method.arguments = args.arguments || {};
        const tool = entry.tools?.find(tool => tool.name === method.tool);
        if (!tool) fail('Read the current tool schemas with catalog_probe first');
        method.effect = tool.effect === 'read' ? 'read' : 'write';
      }
      this.catalog.safeText(JSON.stringify(method), 256 * 1024);
      this.save(entry, { methods: [...methods.filter(method => method.id !== id), method], status: entry.kind === 'cli' ? 'ready' : entry.native?.status || 'configured', resourceRevision: revision }, { revision: entry.revision + 1 });
      this.emit('catalog.updated', { id: entry.id, ownerBotId: entry.ownerBotId });
      return method;
    });
  }

  expand(value, parameters) { return expand(value, parameters, true); }

  invocation(entry, method, args, sessionId) {
    const parameters = { ...(args.parameters || {}) };
    if (sessionId) parameters.sessionId = sessionId;
    if (!method) return { file: entry.config.file, args: nativeArgs(args.args), fileArgs: args.fileArgs, input: args.input, keepInput: args.keepInput === true };
    if (args.fileArgs !== undefined) fail('Use the file argument roles published with the method.');
    const argv = nativeArgs(expand(method.args, parameters));
    const input = args.input ?? expand(method.input, parameters);
    return { file: method.script ? process.execPath : entry.config.file,
      args: method.script ? [join(this.catalog.skillRoot, entry.id, method.script), ...argv] : argv, fileArgs: method.fileArgs,
      input, keepInput: method.keepInput, protocol: method.protocol, env: method.env, authorizedEnv: entry.native.credentialRefs || [], sessionId };
  }

  async priorReadRefusal(entry, actor, task) {
    if (actor === 'controller' || task.status !== 'running' || task.cancelRequested) return;
    return this.manager.readState(actor, db => {
      if (db?.getRecord('works', task.workId)?.status !== 'active' || db.getTask(task.id)?.cancelRequested) return;
      const execution = workExecution(task, db);
      const events = db.listRecords('work-events').filter(event => event.workId === task.workId);
      const index = events.findIndex(event => event.id === execution.executionEventId);
      const current = events[index];
      if (index < 1 || current.kind !== 'request' || current.receipt?.accepted !== true ||
          acceptedWorkTask(current, db)?.id !== task.id || current.cardResume ||
          current.authorization?.production?.relation !== 'continue') return;
      const sourceFor = event => {
        const grant = event.authorization?.production;
        if (grant?.basis !== 'direct' || grant.when !== 'now' || grant.workId !== task.workId || grant.actionId !== event.id) return;
        const origin = db.getTask(event.authorization.requestTaskId);
        const user = origin && currentUserRequest(origin, db);
        if (user && grant.acceptedMessageId === user.acceptedMessageId && grant.messageId === user.messageId && grant.roomId === user.roomId)
          return { ...user, conversationId: origin.conversationId };
      };
      const source = sourceFor(current);
      if (!source) return;
      const isInvocation = record => record.name === 'catalog_native_run' && record.args?.id === entry.id && record.args.methodId;
      const attempted = new Set(db.listTools(task.id).filter(isInvocation).map(record => record.args.methodId));
      const earlierEvents = events.slice(0, index);
      const earlierActions = new Map(earlierEvents.filter(event => event.kind === 'request').map(event => [event.id, event]));
      for (const event of earlierEvents.reverse()) {
        if (event.receipt?.accepted !== true) continue;
        const prior = db.getTask(event.receipt.taskId);
        if (prior?.workId !== task.workId || prior.sessionId !== task.sessionId) continue;
        const original = workExecution(prior, db);
        const root = earlierActions.get(original.executionEventId);
        if (!root?.receipt?.accepted || root.authorization?.actionId !== original.actionId || !acceptedWorkTask(root, db)) continue;
        const earlier = sourceFor(root);
        if (!earlier || earlier.messageId === source.messageId || earlier.roomId !== source.roomId || earlier.conversationId !== source.conversationId) continue;
        for (const record of db.listTools(prior.id).reverse()) {
          if (!isInvocation(record)) continue;
          const { methodId, expectedMethodRevision, operationId, resumeFromOperationId, recoveryBindingId } = record.args;
          if (attempted.has(methodId)) continue;
          attempted.add(methodId);
          const { code, accessDenial, outcomeUnknown } = record.error || {};
          // This validator refuses argument shape before run registers the business operation.
          if (record.status !== 'failed' || record.executionRejected || outcomeUnknown || code !== 'FILE_ACCESS_DENIED' ||
              accessDenial?.reason !== 'undeclared_native_path_operand' || !Number.isSafeInteger(accessDenial.argumentIndex) ||
              resumeFromOperationId || recoveryBindingId || typeof operationId !== 'string' || !/^[\w.:-]{1,256}$/.test(operationId)) continue;
          const method = currentMethod(entry, methodId);
          if (method?.effect !== 'read' || method.revision !== expectedMethodRevision || this.executions.get(actor, task.workId, operationId)) continue;
          return { workId: task.workId, operationId, methodId, methodRevision: method.revision, resourceRevision: method.resourceRevision,
            failedToolRunId: record.id, reason: accessDenial.reason, argumentIndex: accessDenial.argumentIndex,
            nativeOperationRecorded: false, ...(record.assistantMessageId ? {
              invocationReference: { type: 'session', sessionId: prior.sessionId, entryId: record.assistantMessageId },
            } : {}),
            instruction: 'The earlier invocation was refused by the argument validator before its business operation was registered or launched. That receipt applies to the earlier attempt even when the method revision is unchanged. If the current accepted user request requires this exact read and permits it within the original restrictions, check it once through catalog_native_run with the current published method, its expected revision, the same authorized operands and this stable operationId. Apply the current receipt. Preserve hard permission refusals, any user instruction to stop or forbid this read, and unknown write outcomes.' };
        }
      }
    });
  }

  async run(args, actor, task, signal) {
    const context = await this.workContext(actor, task, args);
    if (actor === 'controller') fail('Launch from an accepted Pi work');
    return this.catalog.serial('native-resource:' + args.id, async () => {
      const entry = this.entry(args.id, actor), operationId = required(args.operationId, 'operationId', 256);
      if (!entry.enabled) fail('The resource is disabled', 409);
      const prior = this.executions.get(actor, task.workId, operationId);
      if (prior) {
        if (prior.resourceId !== entry.id || JSON.stringify(prior.intent) !== JSON.stringify(this.catalog.clean(invocationIdentity(args)))) fail('Operation identity already belongs to another invocation', 409);
        return this.executions.public(await this.executions.refresh(prior));
      }
      if (entry.kind === 'cli') {
        try { await this.executablePath(entry.config.file, context, actor, entry, {
          catalogMethod: Boolean(args.methodId && entry.native?.methods?.some(method => method.id === args.methodId)),
        }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const updating = this.executions.forResource(entry.id).some(item => item.effect === 'update' && item.status !== 'queued' && liveNative(item.status));
      const fresh = updating ? entry : await this.check(entry, { actor, task, signal, workspace: context.config?.workspace });
      const method = currentMethod(fresh, args.methodId), unavailable = fresh.native?.status === 'unavailable';
      if (actor !== fresh.ownerBotId && (unavailable || !method && (fresh.kind === 'cli' || args.methodId))) {
        const observed = this.observation(fresh, 'method-needed', { workId: task.workId, methodId: args.methodId, objective: context.work.goal, rationale: args.rationale }, actor);
        const queued = this.enqueue(fresh, unavailable ? 'executable-unavailable' : 'method-needed', observed, actor, task);
        if (queued && !queued.finishedAt) await this.manager.request(actor, '/works/' + encodeURIComponent(task.workId) + '/native-wait', {
          method: 'POST', body: JSON.stringify({ taskId: task.id, maintenanceId: queued.id, resourceId: fresh.id, resourceName: fresh.name }),
        });
        return { status: 'maintenance', resourceId: fresh.id, ownerBotId: fresh.ownerBotId, maintenanceId: queued?.id || null,
          ownerWorkId: queued?.delivery?.ownerWorkId || null };
      }
      if (unavailable) fail('The observed executable is unavailable; find the current installation before calling it', 409);
      if (args.methodId && !method || args.expectedMethodRevision !== undefined && method?.revision !== args.expectedMethodRevision)
        fail('Read the current version and method revision before using it', 409);
      if (!method && actor !== fresh.ownerBotId) fail('Select a published method or delegate the new use to its maintainer', 409);
      const effect = method?.effect || args.effect || 'write';
      if (effect === 'update') {
        this.catalog.owner(fresh, actor);
        const delegated = context.source?.metadata?.nativeUpdateAuthorized;
        if (delegated?.resourceId !== fresh.id && !await this.updateAuthority(actor, task, fresh))
          fail('Updating the installed tool needs the accepted user update request', 403);
      }
      const recovery = args.recoveryBindingId && context.work.bindings.find(binding => binding.id === args.recoveryBindingId && binding.type === 'native-recovery');
      if (args.recoveryBindingId && (!recovery || !recovery.nativeSessionId || effect !== 'read' && recovery.status !== 'resumable'))
        fail('Read and reconcile the original native binding before resuming it', 409);
      if (effect !== 'read') this.requireReconciled(context.work);
      const used = required(args.rationale, 'method selection reason', 1600);
      this.catalog.safeText(JSON.stringify(args), 192 * 1024);
      if (fresh.kind !== 'cli') {
        if (!method?.tool) fail('Use catalog_call for a direct API or MCP tool call');
        return this.catalog.execute(fresh.id, { tool: method.tool, arguments: this.expand(method.arguments, args.parameters || {}), operationId, workId: task.workId }, actor, signal, task);
      }
      const previous = args.resumeFromOperationId && await this.executions.refresh(this.resolveOperation({ operationId: args.resumeFromOperationId }, actor, task));
      if (args.resumeFromOperationId && (!previous?.nativeSessionId || previous.resourceId !== fresh.id || liveNative(previous.status) || previous.status === 'unknown'))
        fail('Resume requires an observed native session on a settled operation in this work', 409);
      const launch = this.invocation(fresh, method, args, previous?.nativeSessionId || recovery?.nativeSessionId);
      launch.cwd = context.cwd;
      if (launch.input !== undefined && (typeof launch.input !== 'string' || launch.input.length > 32_768)) fail('Native stdin payload exceeds the inline input limit');
      nativeCommand(launch.file, launch.args);
      nativeEnvironment(launch.env, launch.authorizedEnv);
      await this.scopedLaunch(launch, context, fresh, method, actor, effect);
      const siblings = this.executions.forResource(fresh.id);
      if (effect !== 'read' && siblings.some(item => item.status === 'unknown' && item.effect !== 'read' && (item.workId === task.workId || item.effect === 'update' || effect === 'update')))
        fail('An original mutation has an unknown outcome; read and reconcile it before another write', 409);
      const item = this.executions.create({ actor, workId: task.workId, taskId: task.id, operationId, executionEventId: context.execution.executionEventId, hostId: this.host.hostId, resourceId: fresh.id, resourceName: fresh.name,
        catalogRevision: fresh.revision, resourceRevision: fresh.native.resourceRevision, version: fresh.native.version || null, methodId: method?.id || null, methodRevision: method?.revision || null,
        cwd: launch.cwd, command: fresh.config.file, effect, rationale: used, intent: this.catalog.clean(invocationIdentity(args)), source: context.source,
        controlRevision: context.work.controlRevision || 0, resumeFromOperationId: previous?.operationId || null }, launch, 'queued');
      const started = await this.advance(item);
      await this.project(started).catch(() => {});
      return this.executions.public(started);
    });
  }

  async scopedLaunch(launch, context, entry, method, actor, effect, createOutputs = false) {
    const file = await this.executablePath(entry.config.file, context, actor, entry, { catalogMethod: Boolean(method) });
    if (hasExplicitFileScope(context.policy) && (method?.script || launch.keepInput || launch.input ||
        ['.cmd', '.bat', '.ps1'].includes(extname(file.file).toLowerCase())))
      throw fileAccessDenied(file.file, 'scoped_direct_executable_required', { operations: ['execute'] });
    const offset = method?.script ? 1 : 0;
    const args = await checkedNativeArguments({ argv: launch.args.slice(offset), templateArgs: method?.args, fileArgs: launch.fileArgs,
      cwd: context.cwd, effect, policy: context.policy, checkedPath: context.checkedPath, createOutputs });
    return { ...launch, file: method?.script ? launch.file : file.canonicalFile, args: [...launch.args.slice(0, offset), ...args] };
  }

  async advance(item) {
    if (item.status !== 'queued') return item;
    const entry = this.catalog.entry(item.resourceId), others = this.executions.forResource(item.resourceId).filter(other => other.id !== item.id);
    const work = await this.manager.readState(item.actor, db => db?.getRecord('works', item.workId));
    if (!work || stopped.has(work.status) || (work.controlRevision || 0) !== item.controlRevision)
      return this.executions.save(item, { status: 'stopped', finishedAt: now(), observedAt: now() });
    if (!entry.enabled || item.resourceRevision !== entry.native.resourceRevision ||
        item.methodId && currentMethod(entry, item.methodId)?.revision !== item.methodRevision)
      return this.executions.save(item, { status: 'superseded', error: 'The resource or method changed before launch; read current state', finishedAt: now(), observedAt: now() });
    const earlierUpdate = others.some(other => other.effect === 'update' && (other.status !== 'queued' ? liveNative(other.status) || other.status === 'unknown' : other.sequence < item.sequence));
    const active = others.some(other => other.status !== 'queued' && liveNative(other.status));
    if (earlierUpdate || item.effect === 'update' && active) return item;
    if (others.some(other => other.workId === item.workId && other.actor === item.actor && other.controlRevision !== item.controlRevision &&
        (liveNative(other.status) || other.status === 'unknown') && other.status !== 'queued')) return item;
    const task = await this.manager.readState(item.actor, db => db?.getTask(item.taskId));
    try {
      const context = await this.workContext(item.actor, task, { workId: item.workId, cwd: item.intent.cwd });
      if (context.execution.executionEventId !== item.executionEventId || !samePath(context.cwd, item.cwd))
        fail('The accepted work action or its working directory changed before launch', 409);
      const launch = await this.scopedLaunch(item.launch, context, entry, currentMethod(entry, item.methodId), item.actor, item.effect, true);
      item = this.executions.save(item, { launch });
    } catch (error) {
      return this.executions.save(item, { status: 'failed', error: this.catalog.clean(error.message),
        ...(error.accessDenial ? { accessDenial: error.accessDenial } : {}), finishedAt: now(), observedAt: now() });
    }
    await this.project(item);
    return this.executions.launch(item);
  }

  resolveOperation(args, actor, task) {
    const workId = task?.workId || args.workId;
    if (!workId || !args.operationId) fail('The original work and operation are required');
    let item = this.executions.get(actor, workId, args.operationId);
    if (!item && task?.workId) {
      const delegation = this.store.list('catalog-delegations').find(record => record.ownerBotId === actor && record.ownerWorkId === task.workId);
      if (delegation?.sourceWorkId) {
        const source = this.executions.get(delegation.actor, delegation.sourceWorkId, args.operationId);
        if (source?.resourceId === delegation.entryId) item = source;
      }
    }
    if (!item) fail('Native operation not found in this work', 404);
    return item;
  }

  async status(args, actor, task) {
    if (task && !task.workId) {
      const visible = await this.manager.readState(actor, db => {
        const work = args.workId && db?.getRecord('works', args.workId), source = taskSource(task, db);
        return source.roomId && work?.sources.some(origin => origin.roomId === source.roomId);
      });
      if (!visible) fail('Choose a native operation in the authorized source conversation', 403);
    }
    if (!args.operationId) return { operations: this.executions.forWork(actor, task?.workId || args.workId).map(item => this.executions.public(item)) };
    const item = await this.executions.refresh(this.resolveOperation(args, actor, task));
    return { ...this.executions.public(item), inputs: await this.executions.inputReceipts(item),
      ...(args.stream ? { output: await this.executions.output(item, args) } : {}) };
  }

  async command(args, actor, task, type) {
    await this.workContext(actor, task, args);
    const item = this.resolveOperation(args, actor, task);
    if (item.actor !== actor || item.workId !== task.workId) fail('Input and stop belong to the original work', 403);
    return this.catalog.serial('native-operation:' + item.id, async () => {
      const current = await this.executions.refresh(this.executions.get(item.actor, item.workId, item.operationId));
      if (type === 'stop') return this.stop(current);
      return this.executions.command(current, { id: required(args.inputId, 'inputId', 256), type, text: args.text, source: 'work:' + task.id });
    });
  }

  async answer(actor, workId, operationId, requestId, input) {
    const item = this.executions.get(actor, workId, operationId);
    if (!item) fail('Native operation not found in this work', 404);
    return this.catalog.serial('native-operation:' + item.id, async () => {
      const work = await this.manager.readState(actor, db => db?.getRecord('works', workId));
      if (!work || stopped.has(work.status)) fail('The original work is stopped', 409);
      const current = await this.executions.refresh(this.executions.get(actor, workId, operationId));
      return this.executions.command(current, { id: required(input.id, 'input identity', 256), type: 'input',
        text: input.text, requestId: required(requestId, 'native request', 256), source: 'user' });
    });
  }

  requireReconciled(work) {
    if (work?.bindings?.some(item => item.type === 'native-recovery' && item.status === 'recovery-required'))
      fail('The original execution must be observed and reconciled before another write in this work', 409);
  }

  async recover(args, actor, task) {
    const context = await this.workContext(actor, task);
    const binding = context.work.bindings.find(item => item.id === args.bindingId && item.type === 'native-recovery');
    if (!binding) fail('Migrated execution binding not found in this work', 404);
    if (!args.disposition) {
      const archive = this.readArchive(binding.archiveId);
      // Tool results also appear in the run detail. Return recovery metadata only.
      const material = JSON.stringify(archive && archive.botId === actor && archive.workId === context.work.id ? {
        priorStatus: archive.priorStatus, priorExecutor: archive.priorExecutor?.kind,
        priorWait: archive.priorWait?.kind, priorStop: archive.priorStop?.status, priorOutcome: archive.priorOutcome?.kind,
        remoteId: archive.remoteId, eventIds: archive.eventIds,
        operations: (archive.operations || []).map(({ id, operationId, action, status, attemptedAt, appliedAt, resultAppliedAt, checkedAt, recordedAt }) =>
          ({ id, operationId, action, status, attemptedAt, appliedAt, resultAppliedAt, checkedAt, recordedAt })),
      } : null);
      const offset = args.offset || 0, next = offset + 16_384;
      return { binding, archivedEvidence: material.slice(offset, next), nextOffset: next < material.length ? next : null };
    }
    const entry = this.entry(args.id, actor), observation = this.observations(args, actor, task);
    if (observation.workId !== context.work.id || observation.type !== 'execution-completed')
      fail('Use an actual completed observation from this original work to reconcile it', 409);
    const evidence = this.catalog.safeText(required(args.evidence, 'observed original effect', 4000));
    if (args.disposition === 'resumable' && !binding.nativeSessionId) fail('No original session ID was recorded', 409);
    if (args.disposition === 'resumable' && observation.nativeSessionId !== binding.nativeSessionId) {
      const item = this.executions.get(actor, context.work.id, observation.operationId);
      const page = item && await this.executions.output(item, { stream: 'stdout', limit: 65_536 });
      if (!page?.text.includes(binding.nativeSessionId)) fail('The observation did not confirm the exact original session', 409);
    }
    return this.manager.request(actor, '/works/' + encodeURIComponent(context.work.id) + '/native-recovery', { method: 'POST',
      body: JSON.stringify({ bindingId: binding.id, expectedRevision: context.work.revision, resourceId: entry.id, status: args.disposition,
        evidence, observationId: observation.id, observedAt: observation.observedAt }) });
  }

  async stopByWork(actor, workId, operationId) {
    const item = this.resolveOperation({ workId, operationId }, actor);
    return this.catalog.serial('native-operation:' + item.id, async () =>
      this.stop(await this.executions.refresh(this.executions.get(actor, workId, operationId))));
  }

  async steer(actor, workId, inputId, text) {
    const work = await this.manager.readState(actor, db => db?.getRecord('works', workId));
    if (!work || stopped.has(work.status)) return null;
    const sessions = this.executions.forWork(actor, workId).filter(item => item.launch?.protocol === 'summon-jsonl' && liveNative(item.status));
    if (sessions.length !== 1) return null;
    const item = sessions[0];
    return this.catalog.serial('native-operation:' + item.id, async () => {
      const fresh = await this.executions.refresh(this.executions.get(actor, workId, item.operationId));
      if (!['starting', 'running', 'awaiting-input'].includes(fresh.status)) return null;
      const receipt = await this.executions.command(fresh, { id: 'steer:' + inputId, type: 'input', text, source: 'user' });
      return { operationId: item.operationId, ...receipt };
    });
  }

  async reconcile(args, actor, task) {
    const item = this.resolveOperation(args, actor, task);
    this.owner(item.resourceId, actor);
    return this.catalog.serial('native-operation:' + item.id, async () => {
      const latest = await this.executions.refresh(this.executions.get(item.actor, item.workId, item.operationId));
      if (latest.status !== 'unknown') fail('Only an unknown original outcome can be reconciled', 409);
      const evidence = this.catalog.safeText(required(args.evidence, 'actual evidence'));
      const saved = this.executions.save(latest, { status: args.outcome, finishedAt: now(), observedAt: now(), error: null, reconciledAt: now(), reconciliation: evidence });
      return this.executions.public(saved);
    });
  }

  async stop(item) {
    if (!liveNative(item.status)) return this.executions.public(item);
    const result = await this.executions.command(item, { id: 'stop:' + item.nonce, type: 'stop', source: 'original-work' });
    this.executions.save(this.executions.get(item.actor, item.workId, item.operationId), { stopRequestedAt: item.stopRequestedAt || now() });
    return result;
  }

  enqueue(entry, kind, observation, actor = 'controller', task) {
    const workId = task?.workId || null;
    if (actor === entry.ownerBotId) return null;
    const revision = entry.native?.resourceRevision || entry.revision;
    const open = this.store.list(tasks).find(job => job.entryId === entry.id && job.actor === actor && job.workId === workId && job.revision === revision && !job.finishedAt);
    const trigger = observation?.operationId || (recurringMaintenance.has(kind) ? observation?.id : kind === 'method-needed' ? task?.id : null);
    const key = open?.id || JSON.stringify([entry.id, kind, revision, actor, workId, trigger || null]);
    const previous = open || this.store.get(tasks, key);
    if (previous && !previous.finishedAt) return this.store.save(tasks, { id: key, kinds: [...new Set([...(previous.kinds || [previous.kind]), kind])], observationIds: [...new Set([...previous.observationIds, observation?.id].filter(Boolean))] });
    if (previous) return previous;
    return this.store.save(tasks, { id: key, entryId: entry.id, ownerBotId: entry.ownerBotId, actor, workId, taskId: task?.id, kind,
      operationId: 'native-maintenance:' + randomUUID(), kinds: [kind], observationIds: [observation?.id].filter(Boolean), revision });
  }

  async maintain(job) {
    const entry = this.catalog.entry(job.entryId);
    const kinds = job.kinds || [job.kind];
    if (!entry.enabled || kinds.every(kind => kind === 'initial-learning') && entry.native?.methods?.some(method => currentMethod(entry, method.id))) {
      this.store.save(tasks, { id: job.id, finishedAt: now() });
      return;
    }
    if (!job.message) {
      const userGoal = job.workId && await this.manager.readState(job.actor, db => db?.getRecord('works', job.workId)?.goal);
      const message = [
        '处理工具维护事件 ' + kinds.join(', ') + '。用 catalog_get 读取当前资源，随后用 catalog_native_observations 或 catalog_get operationId 读取实际来源。',
        '资源 ' + entry.id + '，观察 ' + job.observationIds.join(', ') + '。原工作 ' + (job.workId || '无') + '，' + (userGoal || '') + '。',
        'CLI 优先在当前安装用真实版本/帮助探查，API/MCP 读当前接口。形成可直接执行的方法时用 catalog_native_method_write 登记准确适用条件、版本和来源；修改版本前评估现有方法，保留有效范围。',
        '有具体业务问题时给原工作返回可使用的方法或处理结果，并说明选择理由。检查原生会话和实际效果再处理未知写入。仅观察到变更时保留用户权限边界。',
        '维护工作完成后更新当前工作状态和实际结果。',
        protocolGuide,
      ].join('\n');
      job = this.store.save(tasks, { id: job.id, message, initialObservationIds: job.observationIds });
    }
    const delivery = await this.catalog.handoff(entry.id, { operationId: job.operationId, message: job.message, workId: job.workId,
      sourceTaskId: job.taskId, systemMaintenance: true, nativeMaintenanceId: job.id }, job.actor);
    this.store.save(tasks, { id: job.id, delivery, deliveredObservations: job.initialObservationIds, dispatchedAt: now() });
  }

  async deliverAffected(job, delivery) {
    const entry = this.catalog.entry(job.entryId);
    const calls = this.store.list('catalog-requests').filter(call => call.entryId === entry.id);
    const uses = new Map();
    for (const { actor, workId, taskId } of [...calls, ...this.executions.forResource(entry.id)]) {
      if (workId && taskId && actor !== 'controller' && actor !== entry.ownerBotId && this.catalog.permitted(entry, actor))
        uses.set(JSON.stringify([actor, workId]), { actor, workId, taskId });
    }
    const directlyServed = new Set(this.store.list(tasks).filter(item => item.entryId === entry.id && item.revision === job.revision && item.workId)
      .map(item => JSON.stringify([item.actor, item.workId])));
    for (const [key, { actor, workId, taskId }] of uses) {
      if (directlyServed.has(key)) continue;
      const bot = this.manager.store.get('bots', actor);
      if (!bot || bot.archivedAt || bot.status !== 'active' || bot.runIntent === 'stopped') continue;
      const work = await this.manager.readState(actor, db => db?.getRecord('works', workId));
      if (!work || stopped.has(work.status)) continue;
      await this.manager.start(actor, { respectStop: true });
      await this.manager.request(actor, '/works/' + encodeURIComponent(workId) + '/native-event', { method: 'POST', body: JSON.stringify({
        id: 'catalog-change:' + job.operationId + ':' + workId, taskId, metadata: { actor: entry.ownerBotId, authority: 'peer-observation' },
        content: { type: 'tool-resource-change', entryId: entry.id, ownerBotId: entry.ownerBotId, ownerWorkId: delivery.ownerWorkId,
          maintenanceStatus: delivery.status, resourceRevision: entry.native?.resourceRevision, version: entry.native?.version, observationIds: job.observationIds,
          instruction: 'A current tool used by this work changed. Read catalog_get and these observations before its next call. Consider the effect on this work and preserve any original execution identity.' },
      }) });
    }
  }

  async project(item) {
    if (!item?.workId) return item;
    const { events, offset } = await this.executions.events(item);
    const signature = JSON.stringify([item.status, item.pid, item.nativeSessionId, item.pending, item.error, item.reconciliation, offset]);
    const projection = { eventOffset: offset, projected: signature, projectedStatus: item.status, projectedReconciledAt: item.reconciledAt || null };
    if (item.projected === signature) return item.projectedStatus === item.status ? item : this.executions.save(item, projection);
    const work = await this.manager.readState(item.actor, db => db?.getRecord('works', item.workId));
    if (!work) return item;
    const projectState = () => this.manager.request(item.actor, '/works/' + encodeURIComponent(item.workId) + '/native-state', {
      method: 'POST', body: JSON.stringify({ operation: this.executions.public(item), events, fromOffset: item.eventOffset || 0, toOffset: offset }),
    });
    if (!['cancelled', 'paused'].includes(work.status)) {
      for (const [index, event] of events.entries()) {
        if (event.type === 'request' && item.pending?.some(request => request.id === event.request.id) || ['progress', 'result'].includes(event.type))
          await this.notifyUser(item, event, (item.eventOffset || 0) + ':' + index);
      }
    }
    if (scopeStatus(item.status) && !item.terminalObserved) {
      const entry = this.catalog.entry(item.resourceId);
      const stderr = await this.executions.output(item, { stream: 'stderr' });
      const observed = this.observation(entry, 'execution-' + item.status, { workId: item.workId, operationId: item.operationId,
        revision: item.catalogRevision, resourceRevision: item.resourceRevision, toolVersion: item.version, command: item.command, arguments: item.launch.args, cwd: item.cwd, exitCode: item.exitCode, pid: item.pid,
        nativeSessionId: item.nativeSessionId, error: item.error, stderr: stderr.text, outputRef: this.executions.public(item).outputRef }, item.actor);
      if (item.status === 'failed' || item.status === 'unknown' || item.effect === 'update')
        this.enqueue(entry, item.effect === 'update' ? 'update-' + item.status : 'execution-' + item.status, observed, item.actor, { workId: item.workId, id: item.taskId });
      if (item.effect === 'update' && item.status !== 'unknown') await this.check(entry, { force: true, actor: item.actor, task: { workId: item.workId, id: item.taskId } });
      item = this.executions.save(item, { terminalObserved: observed.id });
    }
    await projectState();
    return this.executions.save(item, projection);
  }

  async checkScheduled(schedule) {
    const entry = this.catalog.entry(schedule.entryId), method = currentMethod(entry, schedule.methodId);
    if (!entry.enabled || !method || method.effect !== 'read') {
      this.store.save(schedules, { id: schedule.id, status: 'needs-current-method', nextAt: Date.now() + schedule.interval });
      return;
    }
    let result, error;
    try {
      if (entry.kind === 'cli') {
        const current = await this.check(entry, { force: true });
        if (!currentMethod(current, method.id)) return;
        const launch = this.invocation(entry, method, { parameters: schedule.parameters });
        result = await inspectNative(launch.file, launch.args, this.workspace, { env: launch.env, authorizedEnv: launch.authorizedEnv });
        if (result.exitCode !== 0 || result.timeout) error = result.error || result.stderr || 'Scheduled observation failed';
      } else {
        await this.catalog.disconnect(entry.id);
        const remote = await this.catalog.execute(entry.id, { tool: method.tool, arguments: this.expand(method.arguments, schedule.parameters || {}) }, entry.ownerBotId);
        result = remote.structuredContent || remote.details || remote.content;
        if (remote.isError) error = 'Scheduled observation returned an error';
      }
    } catch (cause) { error = cause.message; }
    const signature = JSON.stringify(error ? { error: this.catalog.clean(error) } : entry.kind === 'cli' ? [result.stdout, result.stderr] : result);
    this.store.save(schedules, { id: schedule.id, lastCheckedAt: now(), status: error ? 'failed' : 'ready', signature, nextAt: Date.now() + schedule.interval });
    if (schedule.signature !== signature && (schedule.signature !== undefined || error)) {
      const observed = this.observation(entry, error ? 'scheduled-failure' : 'scheduled-change', { result, error });
      this.enqueue(entry, error ? 'scheduled-failure' : 'scheduled-change', observed);
    }
  }

  schedule(args, actor) {
    const entry = this.owner(args.id, actor), method = currentMethod(entry, args.methodId);
    if (!method || method.effect !== 'read' || method.keepInput || method.input) fail('Choose a current non-interactive read method');
    if (!Number.isInteger(args.intervalMinutes) || args.intervalMinutes < 1 || args.intervalMinutes > 10080) fail('Observation interval must be 1 to 10080 minutes');
    this.catalog.safeText(JSON.stringify(args.parameters || {}));
    return this.store.save(schedules, { id: entry.id, entryId: entry.id, methodId: method.id, interval: args.intervalMinutes * 60_000,
      parameters: args.parameters || {}, status: 'scheduled', nextAt: Date.now() });
  }

  async updateAuthority(actor, task, entry) {
    if (!task?.workId) return null;
    return this.manager.readState(actor, db => {
      const execution = workExecution(task, db), origin = execution.requestTaskId && db.getTask(execution.requestTaskId);
      if (!origin) return null;
      const source = taskSource(origin, db);
      const original = source.input?.trigger?.content || source.input?.originalRequest?.content?.goal || source.input?.instruction || source.input;
      const text = typeof original === 'string' ? original : '';
      const names = [entry.id, entry.name, entry.config.executableName].filter(Boolean);
      return source.actor === 'user' && /更新|升级|安装|\b(?:update|upgrade|install)\b/i.test(text) &&
        !/(?:不要|不能|不得|禁止|无需|别|do not|don't|never)\s*(?:更新|升级|安装|update|upgrade|install)/i.test(text) &&
        names.some(name => text.toLowerCase().includes(name.toLowerCase())) ? { resourceId: entry.id, originalTaskId: origin.id } : null;
    });
  }

  async registerNetwork(args, actor, task) {
    if (!['http', 'mcp'].includes(args.kind)) fail('Use host discovery for a CLI');
    const config = this.catalog.checkedConfig(args.kind, args.config);
    const identity = value => {
      if (args.kind === 'mcp') return value.transport === 'http' ? ['mcp-http', new URL(value.url).href] : ['mcp-stdio', value.command, value.args || []];
      return ['http', ...new Set((value.tools || [value]).map(tool => new URL(tool.url).origin))].sort();
    };
    const same = JSON.stringify(identity(config));
    return this.catalog.serial('native-register-network', async () => {
      const previous = this.store.list(entries).find(entry => entry.kind === args.kind && (entry.id === args.id ||
        entry.native?.networkIdentity === same && this.catalog.permitted(entry, actor)));
      if (previous) {
        this.catalog.access(previous, actor);
        if (JSON.stringify(identity(previous.config)) !== same) fail('Catalog identity already belongs to a different endpoint', 409);
        return this.catalog.get(previous.id, actor);
      }
      const context = actor === 'controller' ? null : await this.workContext(actor, task);
      await this.catalog.save(args, actor, { ownerModel: context?.config?.model });
      const entry = this.catalog.entry(args.id);
      this.save(entry, { networkIdentity: same });
      const observation = this.observation(entry, 'interface-source', { source: args.source, transport: args.kind }, actor);
      this.enqueue(entry, 'initial-learning', observation, actor, task);
      return this.catalog.get(entry.id, actor);
    });
  }

  async projectRemote(entry, receipt, actor, task) {
    if (actor === 'controller' || !task?.workId) return;
    return this.catalog.serial('native-remote-projection:' + receipt.id, async () => {
      const current = this.store.get('catalog-requests', receipt.id), signature = remoteProjection(current);
      if (current.nativeReceiptProjected === signature) return;
      const execution = await this.manager.readState(actor, db => workExecution(task, db));
      await this.manager.request(actor, '/works/' + encodeURIComponent(task.workId) + '/native-remote', { method: 'POST',
        body: JSON.stringify({ taskId: task.id, executionEventId: execution.executionEventId, operationId: current.operationId, tool: current.tool, resourceId: entry.id, resourceName: entry.name,
          version: current.version, resourceKind: entry.kind, status: current.status, error: current.error, receivedAt: current.receivedAt,
          observedAt: current.reconciledAt || current.finishedAt || current.startedAt || now() }),
      });
      this.store.save('catalog-requests', { id: current.id, nativeReceiptProjected: signature });
    });
  }

  remoteObservation(entry, type, details, actor, task) {
    const before = this.catalog.entry(entry.id), version = details.server?.version || details.version || before.native?.version || null;
    const hasVersion = Boolean(before.native?.version && version && before.native.version !== version);
    const configChanged = before.native?.configRevision && before.native.configRevision !== before.configRevision;
    const native = { version, configRevision: before.configRevision, status: details.error ? 'observation-failed' : type === 'api-call' || type === 'mcp-interface' ? 'ready' : 'configured',
      lastCheckedAt: now(), resourceRevision: (before.native?.resourceRevision || 1) + Number(Boolean(hasVersion || configChanged)) };
    const saved = this.save(before, native, hasVersion ? { revision: before.revision + 1 } : {});
    const recorded = this.observation(saved, type, details, actor);
    if (hasVersion || details.error) this.enqueue(saved, hasVersion ? 'version-change' : 'connection-failure', recorded, actor, task);
    return recorded;
  }

  background(key, callback) {
    if (this.working.has(key)) return;
    const promise = Promise.resolve().then(callback).catch(error => this.emit('native-tool.error', { message: this.catalog.clean(error.message), key }))
      .finally(() => this.working.delete(key));
    this.working.set(key, promise);
  }

  async tick() {
    this.sources.tick();
    for (const item of this.executions.list().filter(item => liveNative(item.status) || item.projectedStatus !== item.status ||
        item.status === 'unknown' && !item.reconciledAt && Date.now() - Date.parse(item.lastUnknownPoll || item.updatedAt) >= 30_000 ||
        item.reconciledAt && item.projectedReconciledAt !== item.reconciledAt)) {
      this.background('process:' + item.nonce, () => this.catalog.serial('native-resource:' + item.resourceId, async () => {
        let current = this.executions.get(item.actor, item.workId, item.operationId);
        if (current.status === 'queued') current = await this.advance(current);
        current = await this.executions.refresh(current);
        const work = await this.manager.readState(current.actor, db => db?.getRecord('works', current.workId));
        if (liveNative(current.status) && work && (stopped.has(work.status) || (work.controlRevision || 0) !== current.controlRevision))
          await this.catalog.serial('native-operation:' + current.id, () => this.stop(current));
        const latest = this.executions.get(item.actor, item.workId, item.operationId);
        if (latest.status === 'unknown') this.executions.save(latest, { lastUnknownPoll: now() });
        await this.project(latest);
      }));
    }
    const pending = this.store.list(tasks).filter(job => !job.finishedAt);
    const active = new Set();
    for (const job of pending) if (this.working.has('maintenance:' + job.id)) active.add(job.entryId);
    for (const job of pending.filter(job => job.delivery)) {
      const key = JSON.stringify([job.actor, job.entryId, job.operationId]);
      const delivery = this.store.get('catalog-delegations', key);
      if (!delivery?.returnedAt) {
        active.add(job.entryId);
        const fresh = job.observationIds.filter(id => !job.deliveredObservations?.includes(id));
        if (fresh.length && delivery?.taskId) this.background('maintenance-delta:' + job.id, async () => {
          await this.manager.request(delivery.ownerBotId, '/works/' + encodeURIComponent(delivery.ownerWorkId) + '/native-event', { method: 'POST',
            body: JSON.stringify({ id: 'native-maintenance:' + fresh.at(-1), taskId: delivery.taskId,
              content: { type: 'tool-maintenance-observations', entryId: job.entryId, observationIds: fresh,
                instruction: 'Read the new real observations for this same maintenance and update the relevant method.' } }) });
          this.store.save(tasks, { id: job.id, deliveredObservations: [...(job.deliveredObservations || []), ...fresh] });
        });
      }
      else if (!job.workId && (job.kinds || [job.kind]).some(kind => ambientMaintenance.has(kind))) {
        this.background('maintenance-affected:' + job.id, async () => {
          await this.deliverAffected(job, delivery);
          this.store.save(tasks, { id: job.id, finishedAt: delivery.returnedAt, result: delivery.status });
        });
      } else this.store.save(tasks, { id: job.id, finishedAt: delivery.returnedAt, result: delivery.status });
    }
    for (const job of pending.filter(job => !job.delivery && (!job.nextAt || job.nextAt <= Date.now()))) {
      if (active.size >= 4) break;
      if (active.has(job.entryId)) continue;
      active.add(job.entryId);
      this.background('maintenance:' + job.id, async () => {
        try { await this.maintain(job); }
        catch (error) { this.store.save(tasks, { id: job.id, lastError: this.catalog.clean(error.message), nextAt: Date.now() + 30_000 }); }
      });
    }
    for (const entry of this.forHost().filter(item => item.enabled && item.native.versionObserved && (!item.native.lastCheckedAt || Date.now() - Date.parse(item.native.lastCheckedAt) >= 5 * 60_000)).slice(0, 2)) {
      this.background('check:' + entry.id, () => this.catalog.serial('native-resource:' + entry.id, async () => {
        if (this.executions.forResource(entry.id).some(item => item.effect === 'update' && item.status !== 'queued' && liveNative(item.status))) return;
        await this.check(this.catalog.entry(entry.id), { force: true });
      }));
    }
    for (const receipt of this.store.list('catalog-requests').filter(record => record.actor !== 'controller' && record.workId && record.taskId && record.nativeReceiptProjected !== remoteProjection(record)).slice(0, 4))
      this.background('remote:' + receipt.id, async () => {
        const entry = this.store.get(entries, receipt.entryId);
        if (!entry) return;
        const task = await this.manager.readState(receipt.actor, db => db?.getTask(receipt.taskId));
        if (!task) return;
        await this.projectRemote(entry, receipt, receipt.actor, task);
      });
    for (const schedule of this.store.list(schedules).filter(item => item.nextAt <= Date.now()).slice(0, 2))
      this.background('observe:' + schedule.entryId, () => this.catalog.serial('native-resource:' + schedule.entryId, () => this.checkScheduled(schedule)));
  }

  async close() { await Promise.allSettled([...this.working.values(), this.sources.close()]); }

  async call(name, args, { actor, task, signal }) {
    switch (name) {
      case 'discover': return this.discover(args, actor, task);
      case 'enroll': return this.enroll(args, actor, task);
      case 'probe': return this.probe(args, actor, task, signal);
      case 'observations': return this.observations(args, actor, task);
      case 'method_write': return this.methodWrite(args, actor);
      case 'run': return this.run(args, actor, task, signal);
      case 'status': return this.status(args, actor, task);
      case 'input': case 'stop': return this.command(args, actor, task, name);
      case 'reconcile': return this.reconcile(args, actor, task);
      case 'recover': return this.recover(args, actor, task);
      case 'observe_schedule': return this.schedule(args, actor);
      case 'source_register': return this.sources.register(args, actor);
      case 'publish': return this.sources.publish(args, actor);
      default: fail('Unknown native tool action', 404);
    }
  }
}
