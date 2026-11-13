import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { loadConfiguredTools } from '../../bot/src/capabilities/remote-tools.mjs';
import { nativeToolDefinitions } from './native-tool-definitions.mjs';
import { attachNativeMethodReferences, nativeReferencePrefix, nativeReferences, publicNativeReference } from './native-references.mjs';
import { taskMode } from '../../bot/src/capabilities/task-policy.mjs';
import { workExecution } from '../../bot/src/context/sources.mjs';
import { isEnvironmentInitializationSource } from '../../bot/src/context/environment.mjs';
import { fail, safeId, required, within } from '../shared/validation.mjs';

const K = { entries: 'catalog-entries', requests: 'catalog-requests', proposals: 'catalog-skill-proposals', delegations: 'catalog-delegations' };
const string = { type: 'string' }, strings = { type: 'array', items: string }, integer = { type: 'integer', minimum: 0 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const refFields = { workId: string, conversationId: string, originRoomId: string, originMessageId: string, sourceRefs: strings };
const entryFields = { id: string, kind: { type: 'string', enum: ['mcp', 'http'] }, name: string, description: string, config: { type: 'object' }, allowedBotIds: strings, scopeRefs: strings, dependencies: strings, enabled: { type: 'boolean' }, coordination: { type: 'object' }, source: {}, expectedRevision: integer };
export const catalogTools = [...[
  ['catalog_search', 'Find permitted CLI, MCP, API, shared methods and bundled read-only reference files by purpose or scope. Use a reference entry’s nativeArgument.value for a registered CLI method’s read-file parameter. Availability is not business authorization.', 'read', object({ query: string, kind: string, scopeRefs: strings, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 80 } })],
  ['catalog_get', 'Read a catalog entry, its current methods, tool schemas, owner and dependencies, a bundled reference, or a Skill resource. Check a CLI method’s bundledReferences for values that can satisfy its read-only file parameters. In the original work, a CLI entry can include evidence of a prior read refused before launch. Supply operationId to inspect your persisted call receipt without contacting the remote service. resource is SKILL.md or a relative scripts/references/assets path.', 'read', object({ id: string, resource: string, operationId: string }, ['id'])],
  ['catalog_probe', 'Discover an MCP connection’s current tool schemas or load an HTTP configuration. Does not call a business tool. HTTP configuration readiness alone is not a successful API request.', 'read', object({ id: string }, ['id'])],
  ['catalog_register', 'Record an explicitly introduced MCP or HTTP entry once, with credential environment references only. The platform creates its own dedicated maintenance Bot and retains your access. Registration does not authorize continuing business.', 'write', object(entryFields, ['id', 'kind', 'name', 'description', 'config', 'source'])],
  ['catalog_update', 'Update a connection you maintain after an observed change or user correction. Read its revision first. Never put secret values in config; use environment references.', 'write', object(entryFields, ['id', 'expectedRevision'])],
  ['catalog_call', 'Call an allowed catalog tool directly. Supply tool arguments exactly as its schema. Every mutation requires a stable operationId, supplied here or as arguments.operationId when that tool explicitly accepts it; the outer operationId takes precedence. Reuse it to inspect an uncertain receipt, never replace it to retry an unknown write.', 'external', object({ id: string, tool: string, arguments: { type: 'object' }, operationId: string, ...refFields }, ['id', 'tool', 'arguments'])],
  ['catalog_reconcile', 'The responsible Bot may resolve an unknown call only after obtaining concrete independent evidence of its actual outcome. Include that evidence; never infer failure from a timeout or use this to bypass an unresolved write.', 'write', object({ id: string, operationId: string, actor: string, outcome: { type: 'string', enum: ['completed', 'failed'] }, evidence: string }, ['id', 'operationId', 'outcome', 'evidence'])],
  ['catalog_delegate', 'Ask the responsible Bot for a bounded result. Use intent=consult for current-version usage, applicable methods and actual observations. The owner can investigate and maintain its methods within its existing authority. Use intent=perform to delegate a specific authorized business action. Use intent=update only for a directly requested install, upgrade or replacement of the named installed resource. Include original room/message and work IDs for isolated result return.', 'external', object({ id: string, message: string, operationId: string, intent: { type: 'string', enum: ['consult', 'perform', 'update'] }, ...refFields }, ['id', 'message', 'operationId'])],
  ['catalog_skill_write', 'Create or revise one shared Skill from observed reusable evidence. A new Skill gets its own dedicated maintenance Bot; its creator retains access. Search and read existing Skills first. Only its maintainer can revise it; other Bots propose a correction. expectedRevision is mandatory for existing Skills. Credentials and live task state do not belong in Skills.', 'write', object({ id: string, name: string, description: string, content: string, files: { type: 'object', additionalProperties: string }, allowedBotIds: strings, scopeRefs: strings, dependencies: strings, source: {}, expectedRevision: integer, proposalId: string }, ['name', 'description', 'content', 'source'])],
  ['catalog_skill_propose', 'Submit a concrete sourced correction to the shared Skill maintainer. Keeps one shared body; does not create a private copy or overwrite it. The maintainer receives this proposal.', 'external', object({ id: string, content: string, description: string, source: {}, expectedRevision: integer, ...refFields }, ['id', 'content', 'source', 'expectedRevision'])],
].map(([name, description, effect, inputSchema]) => ({ name, description, effect, inputSchema })), ...nativeToolDefinitions];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => String(path).split('.').reduce((part, key) => part?.[key], value);
const stamp = () => new Date().toISOString();
const credentialsFor = (kind, config = {}) => {
  const definitions = kind === 'http' ? config.tools || [config] : [config];
  return definitions.flatMap(def => {
    const headers = Object.entries(def.headersEnv || {}).sort(), environment = Object.entries(def.env || {}).sort();
    return headers.length || environment.length ? [JSON.stringify([def.transport, def.url, def.command, def.args, headers, environment])] : [];
  }).sort();
};
const forbidden = /(?:^|[/\\])(?:\.env(?:[.-]|$)|\.git|\.ssh|credentials?(?:[._-]|$)|secrets?(?:[._-]|$))|\.(?:pem|key|pfx)$/i;
const resourceName = value => {
  if (typeof value !== 'string' || !/^(?:SKILL\.md|(?:scripts|references|assets)\/[A-Za-z0-9_./ -]+)$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || forbidden.test(value)) fail('Invalid Skill resource path');
  return value;
};

/** The existing gateway owns this directory and its execution records in the
 * capability registry database. Skill bodies live only in their shared files. */
export class CapabilityCatalog {
  constructor({ store, registry, manager, dataRoot, workspace, emit = () => {}, delegate }) {
    Object.assign(this, { store, registry, manager, dataRoot, workspace, emit, delegate });
    this.skillRoot = resolve(dataRoot, 'capabilities', 'skills');
    this.connections = new Map(); this.locks = new Map(); this.executions = new Map(); this.controller = new AbortController();
    for (const request of store.list(K.requests)) if (request.status === 'running') store.save(K.requests, { ...request, status: 'unknown', error: 'Gateway restarted before the remote receipt was recorded' });
  }
  async serial(key, operation) {
    const before = this.locks.get(key) || Promise.resolve();
    const task = before.catch(() => {}).then(operation); this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  entry(id) { const entry = this.store.get(K.entries, safeId(id)); if (!entry) fail('Catalog entry not found', 404); return entry; }
  dependencyIds(entry, seen = new Set()) {
    for (const id of entry.dependencies) {
      if (seen.has(id)) continue; seen.add(id);
      const dependency = this.store.get(K.entries, id); if (dependency) this.dependencyIds(dependency, seen);
    }
    return seen;
  }
  permitted(entry, actor) {
    if (actor === 'controller') return true;
    const bot = this.manager.store.get('bots', actor);
    if (bot?.maintenanceFor?.kind === 'catalog') {
      // Derived access follows this maintainer's current, enabled entry only.
      // It neither grants the dependency's users access to the Skill nor
      // admits a dedicated Bot to unrelated entries through a broad '*' ACL.
      const owned = this.store.get(K.entries, bot.maintenanceFor.entryId);
      if (bot.archivedAt || !owned || owned.ownerBotId !== actor) return false;
      return owned.id === entry.id || (owned.enabled && (this.dependencyIds(owned).has(entry.id) || entry.creatorBotId === actor || entry.allowedBotIds.includes(actor)));
    }
    return entry.ownerBotId === actor || entry.allowedBotIds.includes('*') || entry.allowedBotIds.includes(actor);
  }
  access(entry, actor) { if (!this.permitted(entry, actor)) fail('This Bot is not allowed to use this catalog entry', 403); }
  owner(entry, actor) {
    if (actor === 'controller') return;
    const bot = this.manager.get(actor);
    if (actor !== entry.ownerBotId || bot.archivedAt || bot.maintenanceFor && bot.status !== 'active') fail('Only the active responsible Bot can maintain this entry; submit a Skill proposal', 403);
  }
  clean(value) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    const secrets = new Set();
    for (const entry of this.store.list(K.entries)) {
      for (const ref of entry.native?.credentialRefs || []) if (process.env[ref]) secrets.add(process.env[ref]);
      const definitions = entry.kind === 'http' ? entry.config?.tools || [entry.config] : [entry.config];
      for (const def of definitions.filter(Boolean)) {
        for (const ref of Object.values(def.headersEnv || {})) if (process.env[ref]) secrets.add(process.env[ref]);
        for (const ref of Object.values(def.env || {})) if (plain(ref) && process.env[ref.env]) secrets.add(process.env[ref.env]);
      }
    }
    for (const secret of [...secrets].sort((a,b) => b.length-a.length)) text = text.split(secret).join('[redacted]');
    text = text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]');
    return typeof value === 'string' ? text : JSON.parse(text);
  }
  safeText(value, max = 128 * 1024) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > max) fail('Skill text is missing or too large');
    const text = this.clean(value);
    if (text !== value || /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|(?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{16,}/i.test(text)) fail('Credentials belong in private configuration, not catalog text or Skills');
    return text;
  }
  state(entry, seen = new Set()) {
    if (!entry.enabled) return { status: 'disabled', available: false, unavailableReason: 'Entry is disabled' };
    if (seen.has(entry.id)) return { status: 'unavailable', available: false, unavailableReason: 'Dependency cycle' };
    seen.add(entry.id);
    for (const id of entry.dependencies) {
      const dependency = this.store.get(K.entries, id);
      if (!dependency || !this.state(dependency, new Set(seen)).available) return { status: 'unavailable', available: false, unavailableReason: `Dependency unavailable: ${id}` };
    }
    if (entry.kind === 'skill') return { status: 'ready', available: true };
    if (entry.kind === 'cli') return { status: entry.native.status, available: entry.native.status !== 'unavailable' };
    for (const def of this.definitions(entry)) {
      const refs = [...Object.values(def.headersEnv || {}), ...Object.values(def.env || {}).filter(plain).map(value => value.env)];
      if (refs.some(ref => process.env[ref] === undefined)) return { status: 'unavailable', available: false, unavailableReason: 'A referenced credential is not configured' };
    }
    return { status: entry.lastProbe?.status || 'unprobed', available: entry.lastProbe?.status !== 'unavailable', ...(entry.lastProbe?.error ? { unavailableReason: entry.lastProbe.error } : {}) };
  }
  public(entry, detail = false) {
    const { config, resources, ...metadata } = entry;
    const native = entry.native && { ...entry.native,
      methods: (entry.native.methods || []).filter(method => detail || method.resourceRevision === entry.native.resourceRevision).map(method => detail ? { ...method, current: method.resourceRevision === entry.native.resourceRevision } : {
        id: method.id, name: method.name, description: method.description, version: method.version, revision: method.revision, effect: method.effect,
      }) };
    return this.clean({ ...metadata, ...this.state(entry), native, ...(detail
      ? { config, resources: resources || [], displaySources: this.native?.sources.list().filter(source => source.resourceId === entry.id),
        observationSchedule: this.store.get('native-observation-schedules', entry.id) }
      : { resources: undefined, tools: (entry.tools || []).map(({ name, description, effect }) => ({ name, description, effect })) }) });
  }
  async search(input = {}, actor = 'controller', { includeReferences = true } = {}) {
    const { query = '', kind, scopeRefs = [], offset = 0, limit = 40 } = input;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 80) fail('Invalid catalog pagination');
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    let entries = this.store.list(K.entries).filter(entry => this.permitted(entry, actor)).map(entry => this.public(entry));
    if (!kind || kind === 'service') entries.push(...this.registry.inventory().services.map(service => ({ id: `service:${service.id}`, kind: 'service', name: service.id, description: `Installed capability service ${service.id}`, readOnly: true, enabled: service.status === 'active', status: service.status, available: service.status === 'active', ownerBotId: null, scopeRefs: [], dependencies: [] })));
    if (includeReferences && (!kind || kind === 'reference')) entries.push(...nativeReferences);
    entries = entries.filter(entry => (!kind || entry.kind === kind) && (!scopeRefs.length || scopeRefs.some(ref => entry.scopeRefs.includes(ref) || ref === `catalog:${entry.id}` || entry.dependencies.some(id => ref === `catalog:${id}`))) && terms.every(term => JSON.stringify(entry).toLowerCase().includes(term)));
    const page = await Promise.all(entries.slice(offset, offset + limit).map(entry => entry.kind === 'reference' ? publicNativeReference(entry) : entry));
    return { entries: page, total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null };
  }
  async get(id, actor = 'controller', resource, task) {
    if (String(id).startsWith(nativeReferencePrefix)) {
      const reference = nativeReferences.find(item => item.id === id);
      if (!reference || resource) fail('Bundled reference not found', 404);
      return publicNativeReference(reference);
    }
    if (String(id).startsWith('service:')) { const entry = (await this.search({ kind: 'service', limit: 80 }, actor)).entries.find(item => item.id === id); if (!entry) fail('Service not found', 404); return entry; }
    const entry = this.entry(id); this.access(entry, actor);
    if (resource) {
      if (entry.kind !== 'skill') fail('Only Skills have resources');
      if (!this.state(entry).available) fail('Skill or its dependency is unavailable', 409);
      return { ...this.public(entry), path: `catalog:${entry.id}/${resourceName(resource)}`, baseDir: `catalog:${entry.id}/`, content: await this.readResource(entry, resource) };
    }
    const result = this.public(entry, true);
    if (entry.kind === 'cli' && result.available) {
      await attachNativeMethodReferences(result.native.methods);
      if (task?.workId) {
        const recheck = await this.native?.priorReadRefusal(entry, actor, task);
        if (recheck) result.priorReadRefusal = this.clean(recheck);
      }
    }
    if (entry.kind === 'skill' && actor === 'controller') {
      const markdown = await this.readResource(entry, 'SKILL.md');
      result.content = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, '');
      result.files = Object.fromEntries(await Promise.all((entry.resources || []).filter(name => name !== 'SKILL.md').map(async name => [name, await this.readResource(entry, name)])));
    }
    return result;
  }
  async readResource(entry, name) {
    resourceName(name); if (!(entry.resources || []).includes(name)) fail('Skill resource not found', 404);
    const root = join(this.skillRoot, entry.id), path = join(root, name), actual = await realpath(path);
    if (!within(root, actual)) fail('Skill resource escapes its directory');
    const content = await readFile(actual, 'utf8'); if (Buffer.byteLength(content) > 128 * 1024 || content.includes('\0')) fail('Skill resource is too large or is not text');
    return this.clean(content);
  }
  checkedConfig(kind, config) {
    if (!plain(config)) fail('Connection config must be an object');
    if (kind === 'cli') {
      if (!['file', 'canonicalFile', 'executableName'].every(key => typeof config[key] === 'string' && config[key])) fail('A discovered CLI needs its actual executable');
      this.safeText(JSON.stringify(config));
      return structuredClone(config);
    }
    const definitions = kind === 'http' ? config.tools || [config] : [config];
    if (!Array.isArray(definitions) || !definitions.length || definitions.length > 128) fail('HTTP connection needs 1–128 tool definitions');
    for (const definition of definitions) {
      if (!plain(definition)) fail('Invalid tool configuration');
      if (definition.type && definition.type !== kind) fail('Connection tool kind does not match');
      if (definition.headers && Object.keys(definition.headers).length) fail('Use headersEnv credential references, not literal headers');
      if (definition.env && (!plain(definition.env) || Object.values(definition.env).some(value => !plain(value) || typeof value.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)))) fail('Stdio environment values must be {env: NAME} references');
      if (Object.keys(definition).some(key => /^(?:token|password|secret|authorization|api[_-]?key)$/i.test(key))) fail('Use credential environment references, not literal credentials');
      if (definition.args !== undefined && (!Array.isArray(definition.args) || definition.args.some(value => typeof value !== 'string'))) fail('Connection args must be an array of strings');
      if ((definition.args || []).some(value => /^--?(?:token|password|secret|api[_-]?key)(?:=|$)/i.test(value))) fail('Pass stdio credentials through environment references, not command arguments');
      if (definition.headersEnv && (!plain(definition.headersEnv) || Object.values(definition.headersEnv).some(value => typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))) fail('Invalid credential reference');
      if (definition.url) { const url = new URL(definition.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key))) fail('Connection URL cannot embed credentials'); }
      if (kind === 'http' && (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(definition.name || '') || definition.inputSchema?.type !== 'object' || typeof definition.description !== 'string')) fail('HTTP tools need name, description and object inputSchema');
      if (kind === 'mcp' && !['http', 'stdio'].includes(definition.transport)) fail('MCP transport must be http or stdio');
      if ((kind === 'http' || definition.transport === 'http') && typeof definition.url !== 'string') fail('HTTP connections require a URL');
      if (kind === 'mcp' && definition.transport === 'stdio' && (typeof definition.command !== 'string' || !definition.command.trim() || definition.args !== undefined && (!Array.isArray(definition.args) || definition.args.some(arg => typeof arg !== 'string')))) fail('MCP stdio requires a command and optional string args');
    }
    this.safeText(JSON.stringify(config), 512 * 1024);
    return structuredClone(config);
  }
  metadata(input, previous, actor) {
    const kind = previous?.kind || input.kind; if (!['mcp', 'http', 'cli', 'skill'].includes(kind)) fail('Catalog kind must be mcp, http or skill');
    if (input.kind && input.kind !== kind) fail('Catalog kind cannot change');
    const id = safeId(input.id || (kind === 'skill' ? input.name : `${kind}-${randomUUID()}`));
    if (Object.hasOwn(input, 'ownerBotId')) fail('The platform assigns one dedicated maintenance Bot automatically; ownerBotId is read-only');
    const ownerBotId = previous?.ownerBotId || null, createdBy = previous ? previous.createdBy : actor;
    const creatorBotId = previous ? previous.creatorBotId : actor === 'controller' ? null : actor;
    if (creatorBotId) this.manager.get(creatorBotId);
    const list = (field, fallback = []) => { const values = input[field] ?? previous?.[field] ?? fallback; if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length > 256) || values.length > 128) fail(`Invalid ${field}`); return [...new Set(values)]; };
    const allowedBotIds = [...new Set([...list('allowedBotIds'), ...(creatorBotId ? [creatorBotId] : [])])];
    for (const botId of allowedBotIds) if (botId !== '*') this.manager.get(botId);
    const dependencies = list('dependencies'); if (dependencies.includes(id)) fail('A capability cannot depend on itself');
    for (const dependency of dependencies) {
      const target = this.entry(dependency);
      if (!previous?.dependencies.includes(dependency)) {
        this.access(target, actor);
        for (const nestedId of this.dependencyIds(target)) this.access(this.entry(nestedId), actor);
      }
      if (this.dependencyIds(target).has(id)) fail('Catalog dependencies cannot form a cycle');
    }
    const name = required(input.name ?? previous?.name, 'name', 128), description = this.safeText(required(input.description ?? previous?.description, 'description', 4096), 16000);
    if (kind === 'skill' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail('Skill name must use lowercase words separated by hyphens');
    if (kind === 'skill' && this.store.list(K.entries).some(entry => entry.kind === 'skill' && entry.name === name && entry.id !== id)) fail('This Skill name already exists; revise or propose a correction to it', 409);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('enabled must be boolean');
    const coordination = input.coordination ?? previous?.coordination ?? input.config?.coordination;
    if (coordination && (!plain(coordination) || typeof coordination.scope !== 'string' || typeof coordination.argument !== 'string' || !/^[A-Za-z0-9_.]+$/.test(coordination.argument))) fail('coordination requires a stable scope and an argument path');
    return { ...previous, id, kind, name, description, ownerBotId, createdBy, creatorBotId, allowedBotIds, dependencies, scopeRefs: list('scopeRefs'), enabled: input.enabled ?? previous?.enabled ?? true, revision: (previous?.revision || 0) + 1, ...(coordination ? { coordination } : {}) };
  }
  async save(input, actor = 'controller', options = {}) {
    // The public Skill name and catalog identity need not be the same. A
    // maintainer may use the unique name it just read instead of repeating id.
    const namedSkill = !input.id && input.kind === 'skill' && this.store.list(K.entries).find(entry => entry.kind === 'skill' && entry.name === input.name);
    const requestedId = input.id || namedSkill?.id || (input.kind === 'skill' ? input.name : required(input.id, 'id')); safeId(requestedId);
    return this.serial('catalog-edit', async () => {
      const previous = this.store.get(K.entries, requestedId);
      if (!previous && actor !== 'controller' && this.manager.get(actor).maintenanceFor?.kind === 'catalog') fail('A dedicated maintainer revises its assigned entry; it cannot create unrelated catalog entries', 403);
      if (previous) { this.owner(previous, actor); if (input.expectedRevision !== previous.revision) fail('Catalog entry changed; reread its current revision', 409); }
      else if (input.expectedRevision !== undefined && input.expectedRevision !== 0) fail('Catalog entry does not exist at that revision', 409);
      const entry = this.metadata({ ...input, id: requestedId }, previous, actor);
      if (entry.kind === 'cli' && !options.native && (!previous || input.config)) fail('CLI entries come from observed host discovery');
      if (options.native) entry.native = input.native;
      if (Object.hasOwn(input, 'credentialRefs')) {
        if (entry.kind !== 'cli' || actor !== 'controller') fail('Only the user configuration can bind host references to a CLI', 403);
        if (!Array.isArray(input.credentialRefs) || input.credentialRefs.length > 32 ||
            input.credentialRefs.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
          fail('Credential bindings require environment variable names');
        const refs = [...new Set(input.credentialRefs)].sort();
        if (JSON.stringify(refs) !== JSON.stringify(entry.native.credentialRefs || []))
          entry.native = { ...entry.native, resourceRevision: entry.native.resourceRevision + 1, credentialRefs: refs, status: 'changed' };
      }
      if (input.source !== undefined) this.safeText(JSON.stringify(input.source), 64000);
      if (input.proposalId) { const proposal = this.store.get(K.proposals, input.proposalId); if (!proposal || proposal.entryId !== entry.id || proposal.status !== 'pending') fail('Pending Skill proposal does not match'); }
      // Finish all input/resource validation before provisioning the Bot. A
      // failed filesystem write can safely reuse the same maintenanceFor
      // identity on retry; no random replacement Bot is created here.
      let skill;
      if (entry.kind === 'skill') {
        const content = input.content ?? (previous ? (await this.readResource(previous, 'SKILL.md')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, '') : null); this.safeText(content);
        const files = input.files; if (files !== undefined && !plain(files)) fail('Skill files must map relative resource paths to text');
        const currentFiles = previous?.resources || []; const nextFiles = files === undefined ? currentFiles.filter(name => name !== 'SKILL.md') : Object.keys(files);
        let bytes = Buffer.byteLength(content); for (const name of nextFiles) { resourceName(name); if (name === 'SKILL.md') fail('Use content for the Skill body'); if (files) bytes += Buffer.byteLength(this.safeText(files[name])); }
        if (bytes > 1024 * 1024) fail('Skill package exceeds 1 MiB');
        skill = { content, files, currentFiles, nextFiles };
        entry.resources = ['SKILL.md', ...nextFiles]; entry.source = this.clean(input.source ?? previous?.source ?? null);
        if (input.proposalId) { const proposal = this.store.get(K.proposals, input.proposalId); if (!proposal || proposal.entryId !== entry.id) fail('Skill proposal does not match'); entry.lastProposalId = proposal.id; }
      } else {
        entry.config = this.checkedConfig(entry.kind, input.config ?? previous?.config);
        entry.tools = input.config ? [] : previous?.tools || [];
        entry.lastProbe = input.config ? null : previous?.lastProbe || null;
        if (entry.kind !== 'cli') {
          if (actor !== 'controller' && JSON.stringify(credentialsFor(entry.kind, entry.config)) !== JSON.stringify(credentialsFor(entry.kind, previous?.config)))
            fail('Only user configuration may authorize credential references and their actual destination', 403);
          const configChanged = !previous || JSON.stringify(previous.config) !== JSON.stringify(entry.config);
          entry.configRevision = (previous?.configRevision || 0) + Number(configChanged);
          entry.native = { ...previous?.native, hostId: this.native?.host.hostId, configRevision: entry.configRevision,
            resourceRevision: (previous?.native?.resourceRevision || 0) + Number(configChanged), status: configChanged ? 'configured' : previous?.native?.status || 'configured' };
        }
        entry.source = this.clean(input.source ?? previous?.source ?? null);
      }
      if (previous) {
        const owner = this.manager.get(previous.ownerBotId);
        if (owner.maintenanceFor?.kind !== 'catalog' || owner.maintenanceFor.entryId !== entry.id) fail('Catalog maintainer binding is invalid; finish the installation migration before editing', 409);
      }
      const maintainer = await this.manager.ensureCatalogMaintainer({ entryId: entry.id, entryKind: entry.kind, name: entry.name, description: entry.description,
        enabled: previous?.enabled ?? entry.enabled, createdBy: entry.createdBy, ...(options.ownerModel?.connectionStore ? { modelConfig: { connectionStore: options.ownerModel.connectionStore } } : {}) });
      if (previous && maintainer.id !== previous.ownerBotId) fail('Catalog updates cannot replace the dedicated maintenance Bot', 409);
      entry.ownerBotId = maintainer.id;
      let committed = false;
      try {
        if (skill) {
          const { content, files, currentFiles, nextFiles } = skill, root = join(this.skillRoot, entry.id); await mkdir(root, { recursive: true });
          const write = async (name, value) => { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`; try { await writeFile(temp, value, { mode: 0o600 }); await rename(temp, path); } finally { await rm(temp, { force: true }); } };
          if (files) for (const name of nextFiles) await write(name, files[name]);
          await write('SKILL.md', `---\nname: ${entry.name}\ndescription: ${JSON.stringify(entry.description)}\n---\n\n${content}\n`);
          if (files) for (const name of currentFiles) if (name !== 'SKILL.md' && !nextFiles.includes(name)) await rm(join(root, resourceName(name)), { force: true });
        }
        this.store.save(K.entries, entry); committed = true;
        if (input.proposalId) this.store.save(K.proposals, { id: input.proposalId, status: 'merged', mergedRevision: entry.revision, mergedAt: stamp() });
        await this.disconnect(entry.id);
        if (!entry.enabled) this.cancelDelegations(entry.id, 'Catalog entry was disabled');
        await this.manager.setCatalogMaintainerState(entry.id, { enabled: entry.enabled, archived: false });
        this.emit('catalog.updated', { id: entry.id, revision: entry.revision, ownerBotId: entry.ownerBotId });
        return this.get(entry.id, actor);
      } catch (error) {
        if (!previous && !committed) await this.manager.setCatalogMaintainerState(entry.id, { enabled: false, archived: true }).catch(() => {});
        throw error;
      }
    });
  }
  async remove(id, actor = 'controller', expectedRevision) {
    return this.serial('catalog-edit', async () => {
      const entry = this.entry(id); this.owner(entry, actor); if (expectedRevision !== undefined && entry.revision !== expectedRevision) fail('Catalog entry changed', 409);
      const owner = this.manager.get(entry.ownerBotId);
      if (owner.maintenanceFor?.kind !== 'catalog' || owner.maintenanceFor.entryId !== id) fail('Cannot archive a Bot that is not this entry’s dedicated maintainer', 409);
      const unresolved = () => this.store.list(K.requests).some(request => request.entryId === id && request.status === 'unknown');
      if (unresolved()) fail('Reconcile the unknown call outcome before removing this entry; its receipt must remain accessible', 409);
      this.store.save(K.entries, { id, enabled: false });
      this.cancelDelegations(id, 'Catalog entry was removed');
      await this.manager.setCatalogMaintainerState(id, { enabled: false, archived: false });
      await this.disconnect(id);
      await Promise.allSettled([...(this.executions.get(id) || [])]);
      if (unresolved()) fail('The entry is disabled, but an interrupted call has an unknown outcome. Reconcile its receipt before removing the entry', 409);
      await this.manager.setCatalogMaintainerState(id, { enabled: false, archived: true });
      this.store.remove(K.entries, id);
      // Receipts (including unknown effects), proposals and owner conversations
      // remain historical facts. Removing configuration must not erase them or
      // permit an unresolved mutation to be blindly replayed after re-register.
      if (entry.kind === 'skill') { const root = resolve(this.skillRoot, safeId(id)); if (!within(this.skillRoot, root) || root === this.skillRoot) fail('Invalid Skill directory'); await rm(root, { recursive: true, force: true }); }
      this.emit('catalog.removed', { id, ownerBotId: owner.id }); return { id, removed: true, ownerBotId: owner.id, maintainerArchived: true };
    });
  }
  definitions(entry) { return (entry.kind === 'http' ? entry.config.tools || [entry.config] : [entry.config]).map(definition => ({ ...definition, type: entry.kind })); }
  async connection(entry, signal) {
    let pending = this.connections.get(entry.id);
    if (!pending) {
      pending = loadConfiguredTools(this.definitions(entry), { botId: entry.ownerBotId, dataDir: this.dataRoot, workspace: this.workspace, signal: this.controller.signal, redact: value => this.clean(value) });
      this.connections.set(entry.id, pending); pending.catch(() => { if (this.connections.get(entry.id) === pending) this.connections.delete(entry.id); });
    }
    signal?.throwIfAborted(); const connection = await pending; signal?.throwIfAborted(); return connection;
  }
  async disconnect(id) { const pending = this.connections.get(id); this.connections.delete(id); if (pending) await pending.then(connection => connection.close()).catch(() => {}); }
  recordObservation(entry, patch) {
    const current = this.store.get(K.entries, entry.id);
    if (current?.revision === entry.revision) this.store.save(K.entries, { id: entry.id, ...patch });
  }
  cancelDelegations(id, reason) {
    for (const record of this.store.list(K.delegations)) if (record.entryId === id && !record.returnedAt) this.store.save(K.delegations, { id: record.id, cancelReason: reason, cancelledAt: stamp() });
    for (const proposal of this.store.list(K.proposals)) if (proposal.entryId === id && proposal.status === 'pending') this.store.save(K.proposals, { id: proposal.id, status: 'cancelled', reviewStatus: 'cancelled', reviewResult: reason, reviewedAt: stamp() });
  }
  async probe(id, actor = 'controller', signal, task) {
    const entry = this.entry(id); this.access(entry, actor); if (!entry.enabled) fail('Catalog entry is disabled', 409);
    if (entry.kind === 'skill') return this.get(id, actor);
    if (entry.kind === 'cli') fail('Read the CLI interface with catalog_native_probe');
    try {
      const connection = await this.connection(entry, signal); const tools = connection.tools.map(({ name, description, inputSchema, effect }) => ({ name, description, inputSchema, effect }));
      this.recordObservation(entry, { tools, lastProbe: { status: 'ready', scope: entry.kind === 'http' ? 'configuration' : 'transport', at: stamp() } });
      this.native?.remoteObservation(entry, entry.kind === 'mcp' ? 'mcp-interface' : 'api-configuration',
        { tools, server: connection.serverInfo, version: entry.kind === 'http' ? entry.config.apiVersion : undefined, source: entry.source }, actor, task);
      return this.get(id, actor);
    } catch (error) {
      this.recordObservation(entry, { lastProbe: { status: 'unavailable', at: stamp(), error: this.clean(error.message) } });
      this.native?.remoteObservation(entry, 'interface-failure', { error: error.message }, actor, task);
      await this.disconnect(id); throw error;
    }
  }
  async execute(id, input, actor = 'controller', signal, task) {
    const entry = this.entry(id); this.access(entry, actor); if (entry.kind === 'skill' || entry.kind === 'cli') fail('Use catalog_native_run for CLI methods');
    if (!entry.enabled || entry.dependencies.some(dependency => !this.state(this.entry(dependency)).available)) fail('Connection or dependency is disabled or unavailable', 409);
    const connection = await this.connection(entry, signal); const tool = connection.tools.find(item => item.name === input.tool); if (!tool) fail('Catalog tool not found', 404);
    if(actor!=='controller'&&taskMode(task)!=='work'&&tool.effect!=='read')fail('Frontend catalog calls only allow read-only tools; delegate execution to work',403);
    const args = validateToolArguments({ name: tool.name, parameters: tool.inputSchema }, { id: input.operationId || randomUUID(), name: tool.name, arguments: input.arguments || {} });
    const suppliedOperationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId
      : typeof args.operationId === 'string' && args.operationId.trim() ? args.operationId : null;
    const mutation = tool.effect !== 'read';
    if (mutation && task?.workId) this.native?.requireReconciled(await this.manager.readState(actor, db => db?.getRecord('works', task.workId)));
    if (mutation && !suppliedOperationId) fail('A mutation needs a stable operationId at the catalog_call top level (or arguments.operationId when the selected tool accepts it)');
    const operationId = suppliedOperationId || randomUUID(); if (operationId.length > 256) fail('Invalid operationId');
    const requestId = JSON.stringify([actor, id, operationId]);
    const value = entry.coordination ? at(args, entry.coordination.argument) : null;
    const hasResource = entry.coordination && value !== undefined && value !== null && typeof value !== 'object';
    if (entry.coordination && mutation && !hasResource) fail('The configured coordination argument must resolve to one resource identity');
    const resource = hasResource ? JSON.stringify([entry.coordination.scope, value]) : `connection:${id}`;
    const execution = this.serial(`operation:${requestId}`, async () => {
      const prior = this.store.get(K.requests, requestId);
      if (prior) {
        if (prior.tool !== tool.name || JSON.stringify(prior.arguments) !== JSON.stringify(this.clean(args))) fail('operationId already belongs to different arguments', 409);
        if (prior.result !== undefined) return { ...prior.result, catalog: { id, operationId, status: prior.status, replayed: true } };
        if (prior.reconciledAt && ['completed', 'failed'].includes(prior.status)) {
          const details = { reconciled: true, outcome: prior.status, evidence: prior.evidence, reconciledAt: prior.reconciledAt, originalReceiptMissing: true };
          return { content: [{ type: 'text', text: prior.status === 'completed'
            ? '已依据独立证据确认完成；原远端回执缺失。本次只返回核对记录，没有再次执行。'
            : '已依据独立证据确认失败；原远端回执缺失。本次只返回核对记录，没有再次执行。' }],
            details, isError: prior.status === 'failed', catalog: { id, operationId, status: prior.status, replayed: true, ...details } };
        }
        throw Object.assign(new Error(prior.error || 'Remote outcome remains unknown; the mutation was not repeated'), { status: 409, outcomeUnknown: prior.status === 'unknown', code: prior.status === 'unknown' ? 'REMOTE_OUTCOME_UNKNOWN' : 'CATALOG_PREVIOUS_FAILURE' });
      }
      const run = async () => {
        const fresh = this.entry(id); this.access(fresh, actor); if (!fresh.enabled || fresh.revision !== entry.revision) fail('Connection changed before execution; reread it', 409);
        if (mutation && this.store.list(K.requests).some(request => request.resource === resource && request.status === 'unknown')) throw Object.assign(new Error('An earlier write to this resource has an unknown outcome; inspect and reconcile it before another mutation'), { status: 409, code: 'REMOTE_OUTCOME_UNKNOWN', outcomeUnknown: true });
        const base = { id: requestId, entryId: id, operationId, actor, taskId: task?.id, tool: tool.name, arguments: this.clean(args), resource, effect: tool.effect, workId: task?.workId || input.workId || null, status: 'running', version: entry.native?.version || null, startedAt: stamp() };
        this.store.save(K.requests, base); let executing = false, received = false;
        try {
          signal?.throwIfAborted();
          await this.native?.projectRemote(entry, base, actor, task);
          signal?.throwIfAborted(); executing = true;
          const result = await tool.execute(args, { signal, botId: actor, workId: base.workId }); received = true;
          const status = result?.isError ? 'failed' : 'completed'; const cleaned = this.clean(result);
          const saved = this.store.save(K.requests, { ...base, status, result: cleaned, receivedAt: stamp(), finishedAt: stamp() });
          await this.native?.projectRemote(entry, saved, actor, task).catch(() => {});
          if (this.entry(id).revision === entry.revision) this.native?.remoteObservation(entry, status === 'failed' ? 'api-call-failed' : 'api-call', { operationId, workId: base.workId, result: cleaned, server: connection.serverInfo, ...(status === 'failed' ? { error: 'Remote tool returned an error' } : {}) }, actor, task);
          this.recordObservation(entry, { lastProbe: { status: 'ready', scope: 'business-call', at: stamp() }, tools: connection.tools.map(({ name, description, inputSchema, effect }) => ({ name, description, inputSchema, effect })) });
          return { ...cleaned, catalog: { id, operationId, status, replayed: false } };
        } catch (error) {
          const unknown = mutation && executing && (error.outcomeUnknown || error.name === 'AbortError' || signal?.aborted || received);
          const status = unknown ? 'unknown' : 'failed', message = this.clean(error.message);
          const saved = this.store.save(K.requests, { ...base, status, error: message, finishedAt: stamp() });
          await this.native?.projectRemote(entry, saved, actor, task).catch(() => {});
          if (this.entry(id).revision === entry.revision) this.native?.remoteObservation(entry, 'api-call-failed', { operationId, workId: base.workId, error: message, outcomeUnknown: unknown }, actor, task);
          if (error.outcomeUnknown || error.name === 'AbortError' || /fetch failed|connect|closed|transport/i.test(message)) { this.recordObservation(entry, { lastProbe: { status: 'unavailable', at: stamp(), error: message } }); await this.disconnect(id); }
          throw Object.assign(new Error(message), { status: error.status || 502, code: unknown ? 'REMOTE_OUTCOME_UNKNOWN' : error.code, outcomeUnknown: unknown });
        }
      };
      return hasResource ? this.serial(`resource:${resource}`, run) : run();
    });
    if (!this.executions.has(id)) this.executions.set(id, new Set());
    this.executions.get(id).add(execution);
    try { return await execution; }
    finally { const calls = this.executions.get(id); calls?.delete(execution); if (!calls?.size) this.executions.delete(id); }
  }
  requests(id, actor = 'controller') { const entry = this.entry(id); this.owner(entry, actor); return this.clean(this.store.list(K.requests).filter(request => request.entryId === id)); }
  receipt(id, operationId, actor = 'controller') {
    const entry = this.entry(id); this.access(entry, actor);
    const request = this.store.list(K.requests).find(item => item.entryId === id && item.operationId === operationId && item.actor === actor);
    if (!request) fail('Call receipt not found for this actor', 404); return this.clean(request);
  }
  reconcile(id, operationId, input, actor = 'controller') {
    this.owner(this.entry(id), actor);
    const request = this.store.list(K.requests).find(value => value.entryId === id && value.operationId === operationId && (!input.actor || input.actor === value.actor));
    if (!request || request.status !== 'unknown') fail('Unknown request not found', 404);
    if (!['completed', 'failed'].includes(input.outcome)) fail('Reconciliation outcome must be completed or failed');
    return this.store.save(K.requests, { ...request, status: input.outcome, originalError: request.error || null,
      error: input.outcome === 'failed' ? 'Independently confirmed failed; original remote receipt is missing' : null,
      evidence: this.safeText(required(input.evidence, 'evidence', 16000)), reconciledAt: stamp() });
  }
  async handoff(id, input, actor = 'controller') {
    const entry = this.entry(id); this.access(entry, actor); if (!entry.enabled) fail('Catalog entry is disabled', 409);
    if (entry.ownerBotId === actor) return { ownerBotId: actor, self: true, instruction: 'You already maintain this capability; continue in this work.' };
    const proposal = input.proposalId && this.store.get(K.proposals, input.proposalId);
    const correctionOnly = proposal?.entryId === id && proposal.actor === actor && proposal.status === 'pending';
    const message = `能力 ${entry.name} (${entry.id}) 的有界委托；仅处理下述请求，不扩大持续授权。\n${required(input.message, 'message')}`;
    // Business delegation always creates an isolated owner work, including
    // requests originating in a room. The worker never enters a chat DM.
    const sourceWork = actor !== 'controller' && input.workId && await this.manager.readState(actor, db => db?.getRecord('works', input.workId));
    if (actor !== 'controller' && !correctionOnly && !sourceWork) fail('A real source work is required for a delegation');
    const operationId = required(input.operationId, 'operationId', 256), key = JSON.stringify([actor, id, operationId]);
    return this.serial(`delegation:${key}`, async () => {
      let record = this.store.get(K.delegations, key);
      if (record && (record.message !== message || record.sourceWorkId !== (input.workId || null))) fail('Delegation operationId already belongs to another request', 409);
      record ||= this.store.save(K.delegations, { id: key, entryId: id, operationId, actor, sourceWorkId: input.workId || null,
        ownerBotId: entry.ownerBotId, ownerWorkId: `catalog-${randomUUID()}`, sourceTaskId: input.sourceTaskId || null,
        systemMaintenance: input.systemMaintenance === true, nativeMaintenanceId: input.systemMaintenance === true ? input.nativeMaintenanceId || null : null,
        nativeUpdateAuthorized: input.nativeUpdateAuthorized || null, project: input.systemMaintenance === true ? null : sourceWork?.project || null,
        sourceConversationId: input.conversationId || null, proposalId: correctionOnly ? proposal.id : null, message, status: 'pending' });
      record = await this.dispatchDelegation(record);
      return { entryId: id, ownerBotId: record.ownerBotId, ownerWorkId: record.ownerWorkId, taskId: record.taskId, sourceWorkId: record.sourceWorkId, status: record.status, accepted: true };
    });
  }
  async dispatchDelegation(record) {
    const entry = this.store.get(K.entries, record.entryId);
    if (!entry?.enabled || record.cancelReason) fail('Catalog entry no longer accepts maintenance or delegation work', 409);
    if (record.taskId) return record;
    await this.manager.start(record.ownerBotId);
    await this.manager.request(record.ownerBotId, '/works', { method: 'POST', body: JSON.stringify({ id: record.ownerWorkId, goal: record.message, ...(record.project ? { project: record.project } : {}),
      sources: [{ source: record.actor, metadata: { sourceWorkId: record.sourceWorkId, delegationId: record.id, entryId: record.entryId } }] }) });
    const receipt = await this.manager.send(record.ownerBotId, { id: `catalog:${record.ownerWorkId}`, workId: record.ownerWorkId, kind: 'request',
      content: `${record.message}\n这是独立工作 ${record.ownerWorkId}。完成时更新该 work 的状态与实际结果；平台会把终态返回请求方的原工作。`,
      metadata: { sourceType: 'peer', actor: record.actor, authority: record.actor === 'controller' ? 'user-request' : 'peer-request', sourceWorkId: record.sourceWorkId, delegationId: record.id, ...(record.nativeUpdateAuthorized ? { nativeUpdateAuthorized: record.nativeUpdateAuthorized } : {}) } });
    return this.store.save(K.delegations, { ...record, taskId: receipt.taskId, status: 'accepted', acceptedAt: stamp() });
  }
  async tick() {
    if (this.ticking || this.controller.signal.aborted) return; this.ticking = true;
    try {
      for (const listed of this.store.list(K.delegations).filter(item => !item.returnedAt ||
        item.environmentObservation && !item.observationDeliveredAt && (!item.lastAttemptAt || Date.now() - Date.parse(item.lastAttemptAt) >= 30_000))) {
        if (this.controller.signal.aborted) break;
        await this.serial(`delegation:${listed.id}`, async () => {
          let record = this.store.get(K.delegations, listed.id); if (!record) return;
          try {
            if (record.returnedAt) {
              await this.projectEnvironmentObservation(record);
              return;
            }
            const entry = this.store.get(K.entries, record.entryId);
            if (!entry?.enabled || record.cancelReason) {
              await this.finishDelegation(record, 'cancelled', record.cancelReason || 'Catalog entry is disabled or removed');
              return;
            }
            record = await this.dispatchDelegation(record);
            const observation = await this.manager.readState(record.ownerBotId, db => {
              const work = db?.getRecord('works', record.ownerWorkId), task = db?.getTask(work?.lastTaskId || record.taskId);
              return { work, task };
            });
            const finalWork = ['completed', 'cancelled', 'blocked'].includes(observation.work?.status) && !['accepted', 'running'].includes(observation.task?.status);
            const finalTask = ['failed', 'cancelled', 'interrupted'].includes(observation.task?.status);
            if (!finalWork && !finalTask) return;
            const status = finalWork ? observation.work.status : observation.task.status;
            const content = this.clean(observation.task?.result?.content || observation.task?.error?.message || observation.work?.progress || `Owner work ended: ${status}`);
            await this.finishDelegation(record, status, content);
          } catch (error) { this.store.save(K.delegations, { id: record.id, lastError: this.clean(error.message), lastAttemptAt: stamp() }); }
        });
      }
    } finally { this.ticking = false; }
  }
  async finishDelegation(record, status, content) {
    const source = record.actor !== 'controller' && this.manager.store.get('bots', record.actor);
    const environment = record.systemMaintenance && record.sourceWorkId?.startsWith('onboarding-') && record.sourceTaskId &&
      await this.manager.readState(record.actor, db => {
        const task = db?.getTask(record.sourceTaskId);
        return task?.workId === record.sourceWorkId && isEnvironmentInitializationSource(workExecution(task, db).authorization?.source);
      });
    if (environment) {
      this.store.save(K.delegations, { id: record.id, status, result: content, returnedAt: stamp(), lastError: null, lastAttemptAt: null,
        environmentObservation: true });
      return;
    }
    const stoppedMaintainer = source?.maintenanceFor?.kind === 'catalog' && source.status !== 'active';
    if (!record.proposalId && source && !source.archivedAt && !stoppedMaintainer && record.sourceWorkId) {
      await this.manager.start(record.actor);
      await this.manager.request(record.actor, `/works/${encodeURIComponent(record.sourceWorkId)}/native-event`, { method: 'POST', body: JSON.stringify({
        id: `catalog-return:${record.ownerWorkId}`, taskId: record.sourceTaskId, content: { instruction: '这是负责 Bot 的实际终态，沿原工作处理。不要为致谢再次委托，不重放结果未知的写入。', entryId: record.entryId, ownerBotId: record.ownerBotId, ownerWorkId: record.ownerWorkId, status, content },
        metadata: { authority: 'peer-observation', sourceType: 'catalog', actor: record.ownerBotId, purpose: 'result', sourceWorkId: record.ownerWorkId, maintenanceId: record.nativeMaintenanceId, priority: 'background' } }) });
    }
    if (record.proposalId) this.store.save(K.proposals, { id: record.proposalId, reviewStatus: status, reviewedAt: stamp(), reviewResult: content });
    this.store.save(K.delegations, { ...record, status, result: content, returnedAt: stamp(), lastError: null, ...(source?.archivedAt || stoppedMaintainer ? { deliverySkipped: 'source-maintainer-inactive' } : {}) });
  }
  async projectEnvironmentObservation(record) {
    const source = this.manager.store.get('bots', record.actor);
    if (!source || source.archivedAt || source.status !== 'active' || source.runIntent !== 'running') return;
    const entry = this.store.get(K.entries, record.entryId);
    const receipt = await this.manager.request(record.actor, `/works/${encodeURIComponent(record.sourceWorkId)}/native-event`, { method: 'POST', body: JSON.stringify({
      id: `catalog-return:${record.ownerWorkId}`, taskId: record.sourceTaskId,
      content: { type: 'tool-maintenance-result', entryId: record.entryId, entryName: entry?.name, ownerBotId: record.ownerBotId,
        ownerWorkId: record.ownerWorkId, status: record.status, content: record.result },
      metadata: { authority: 'peer-observation', actor: record.ownerBotId, maintenanceId: record.nativeMaintenanceId, observedAt: record.returnedAt },
    }) });
    if (!receipt.observed) fail('The environment maintenance source observation was not recorded', 409);
    this.store.save(K.delegations, { id: record.id, observationDeliveredAt: stamp(), lastError: null });
  }
  async propose(input, actor = 'controller') {
    const entry = this.entry(input.id); this.access(entry, actor); if (entry.kind !== 'skill') fail('Only Skills accept method corrections');
    if (!entry.enabled) fail('Catalog entry is disabled', 409);
    if (entry.revision !== input.expectedRevision) fail('Skill changed; reread before proposing', 409);
    const content = this.safeText(input.content), source = this.clean(input.source);
    if (!source) fail('A sourced observation is required');
    const duplicate = this.store.list(K.proposals).find(proposal => proposal.entryId === entry.id && proposal.actor === actor && proposal.status === 'pending' &&
      proposal.expectedRevision === input.expectedRevision && (proposal.workId || null) === (input.workId || null) &&
      (proposal.conversationId || null) === (input.conversationId || null) && proposal.content === content);
    if (duplicate?.delivery) return duplicate;
    const proposal = duplicate || this.store.save(K.proposals, { entryId: entry.id, actor, ownerBotId: entry.ownerBotId, content, description: input.description, source, expectedRevision: input.expectedRevision, workId: input.workId || null, conversationId: input.conversationId || null, status: 'pending' });
    const message = `共享 Skill ${entry.name} 收到具体修订建议 ${proposal.id}。读取 catalog_get {id:${JSON.stringify(entry.id)},resource:"SKILL.md"}，结合来源判断是否合并；只在有可靠复用证据时用 catalog_skill_write 更新同一份正文并传 proposalId。提案不是新业务授权。\n${JSON.stringify({ proposalId: proposal.id, content, source, expectedRevision: proposal.expectedRevision })}`;
    try { const delivery = await this.handoff(entry.id, { ...input, proposalId: proposal.id, message, operationId: `proposal:${proposal.id}` }, actor); return this.store.save(K.proposals, { ...proposal, delivery, deliveredAt: stamp(), deliveryError: null }); }
    catch (error) { this.store.save(K.proposals, { ...proposal, deliveryError: this.clean(error.message) }); throw error; }
  }
  async call(name, args, { actor = 'controller', signal, task } = {}) {
    const { _context, ...supplied } = args;
    args = { ...supplied, ...(plain(_context) ? Object.fromEntries(['workId','conversationId','originRoomId','originMessageId','sourceRefs'].filter(key => _context[key] !== undefined).map(key => [key, _context[key]])) : {}) };
    if (name.startsWith('catalog_native_')) return this.native.call(name.slice('catalog_native_'.length), args, { actor, signal, task });
    switch (name) {
      case 'catalog_search': return this.search(args, actor);
      case 'catalog_get': return args.operationId ? this.receipt(args.id, args.operationId, actor) : this.get(args.id, actor, args.resource, task);
      case 'catalog_probe': return this.probe(args.id, actor, signal, task);
      case 'catalog_register': return this.native.registerNetwork(args, actor, task);
      case 'catalog_update': this.entry(args.id); return this.save(args, actor);
      case 'catalog_call': return this.execute(args.id, args, actor, signal, task);
      case 'catalog_reconcile': return this.reconcile(args.id, args.operationId, args, actor);
      case 'catalog_delegate': {
        const update = args.intent === 'update' && await this.native.updateAuthority(actor, task, this.entry(args.id));
        if (args.intent === 'update' && !update) fail('A direct user request for this installed resource is required. This call was refused before sending any delegation. If you need the current version’s usage, methods or observed capabilities, ask that question using catalog_delegate with intent=consult and the same resource and operationId.', 403);
        return this.handoff(args.id, { ...args, sourceTaskId: task?.id, systemMaintenance: false, nativeUpdateAuthorized: update }, actor);
      }
      case 'catalog_skill_write': return this.save({ ...args, kind: 'skill' }, actor);
      case 'catalog_skill_propose': return this.propose(args, actor);
      default: fail('Unknown catalog tool', 404);
    }
  }
  async close() { this.controller.abort(new Error('Catalog is closing')); await Promise.allSettled([...this.connections.keys()].map(id => this.disconnect(id))); await Promise.allSettled([...this.locks.values()]); }
}
