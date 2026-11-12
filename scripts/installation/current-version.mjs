import { readdir, readFile, writeFile, rename, rm, realpath, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { migrateNativeExecution } from './native-cutover.mjs';

const inside = (root, path) => { const part = relative(root, path); return part && !part.startsWith('..') && !isAbsolute(part); };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function saveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function removeWithin(root, target) {
  root = resolve(root); target = resolve(target);
  if (!inside(root, target)) throw new Error(`Refusing cleanup outside its named root: ${target}`);
  let stat; try { stat = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isSymbolicLink()) {
    const actualRoot = await realpath(root), actualTarget = await realpath(target);
    if (!inside(actualRoot, actualTarget)) throw new Error(`Cleanup target resolves outside its named root: ${target}`);
  }
  await rm(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}
const entries = async path => readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const unfinished = value => ['queued', 'accepted', 'running', 'waiting'].includes(value.status);
const activeBuild = name => {
  const pid = Number(/\.building-(\d+)$/.exec(name)?.[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

/** Full installs stop every writer first, replace operational configuration, and
 * retain only the current release. Business history and user files are retained. */
export async function selectCurrentVersion({ appRoot, dataRoot, sourceRoot, releaseRoot, buildId, deferredCleanupPaths = [] }) {
  appRoot = resolve(appRoot); dataRoot = resolve(dataRoot); releaseRoot = resolve(releaseRoot);
  if (!inside(join(appRoot, 'releases'), releaseRoot)) throw new Error('Current release must belong to the installation');
  if (sourceRoot) {
    sourceRoot = resolve(sourceRoot);
    const pkg = await readJson(join(sourceRoot, 'package.json'));
    if (pkg.name !== 'summon-bot' || !existsSync(join(sourceRoot, 'AGENTS.md'))) throw new Error('Invalid Summon Bot source root for build cleanup');
  }
  if (!Array.isArray(deferredCleanupPaths) || deferredCleanupPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || !sourceRoot || !inside(join(sourceRoot, 'dist/releases'), resolve(path))))
    throw new Error('Deferred cleanup requires exact absolute source build paths');
  const deferred = new Set(deferredCleanupPaths.map(path => resolve(path).toLowerCase())), cleanupDeferred = [];
  const { RecordStore } = await import(pathToFileURL(join(releaseRoot, 'capabilities/shared/store.mjs')));
  const { BotStore } = await import(pathToFileURL(join(releaseRoot, 'bot/src/storage/store.mjs')));
  const { BUILTIN_CAPABILITIES, capabilityForTool } = await import(pathToFileURL(join(releaseRoot, 'capabilities/services/builtin.mjs')));
  const { toolDefinitions } = await import(pathToFileURL(join(releaseRoot, 'capabilities/gateway/tools.mjs')));
  const { controlTools, bundledToolTimeout } = await import(pathToFileURL(join(releaseRoot, 'capabilities/services/control.mjs')));
  const { catalogTools } = await import(pathToFileURL(join(releaseRoot, 'capabilities/services/catalog.mjs')));
  const { CATALOG_MAINTAINER_TOOLS } = await import(pathToFileURL(join(releaseRoot, 'capabilities/bot-management/service.mjs')));
  const { dutyOrigin, effectiveBotTools } = await import(pathToFileURL(join(releaseRoot, 'capabilities/bot-management/tool-access.mjs')));
  const nativeMigration = await migrateNativeExecution(dataRoot, { RecordStore, BotStore });
  const deployment = await readJson(join(dataRoot, 'config/deployment.json'));
  const registryPath = join(dataRoot, 'capabilities/registry/state.sqlite');
  const retained = new Map(BUILTIN_CAPABILITIES.map(id => [id, buildId]));
  if (existsSync(registryPath)) {
    const registry = new RecordStore(registryPath);
    try {
      for (const service of registry.list('capability-services')) {
        if (service.id !== 'codex' && !BUILTIN_CAPABILITIES.includes(service.id) && service.status === 'active' && service.activeVersion) retained.set(service.id, service.activeVersion);
      }
      registry.transaction(() => {
        for (const kind of ['capability-services', 'capability-versions']) for (const record of registry.list(kind)) {
          const id = kind === 'capability-services' ? record.id : record.capabilityId;
          if (id === 'codex' || BUILTIN_CAPABILITIES.includes(id) || retained.get(id) !== (kind === 'capability-services' ? record.activeVersion : record.version)) registry.remove(kind, record.id);
        }
        for (const kind of ['capability-actors', 'capability-proposals', 'switches', 'capability-retirements', 'service-restarts']) for (const record of registry.list(kind)) registry.remove(kind, record.id);
      });
    } finally { registry.close(); }
  }
  const rebase = value => {
    if (typeof value !== 'string' || !isAbsolute(value)) return value;
    const part = relative(join(appRoot, 'releases'), value);
    if (!part || part.startsWith('..') || isAbsolute(part)) return value;
    return join(releaseRoot, ...part.split(/[\\/]/).slice(1));
  };
  let bots = 0;
  const managementPath = join(dataRoot, 'capabilities/bot-management/state.sqlite');
  const botRecords = new Map();
  if (existsSync(managementPath)) {
    const management = new RecordStore(managementPath);
    try {
      for (const record of management.list('bots')) {
        const profile = await readJson(join(releaseRoot, 'roles', record.roleId || 'default', 'role.json'));
        const allowedTools = record.maintenanceFor ? [...CATALOG_MAINTAINER_TOOLS] : effectiveBotTools(record, [...new Set([...(record.allowedTools || []), ...(profile.tools || [])])]);
        const updated = management.save('bots', { ...record, executor: 'pi', allowedTools }); botRecords.set(record.id, updated);
      }
    } finally { management.close(); }
  }
  for (const directory of await entries(join(dataRoot, 'bots'))) {
    if (!directory.isDirectory()) continue;
    const path = join(dataRoot, 'bots', directory.name, 'config.json'); if (!existsSync(path)) continue;
    const config = await readJson(path);
    const record = botRecords.get(config.botId);
    config.usage = { ledgerPath: join(dataRoot, 'usage.sqlite'), botName: record?.name || config.botId };
    const profile = record && await readJson(join(releaseRoot, 'roles', record.roleId || 'default', 'role.json'));
    if (record) {
      config.prompt = [await readFile(join(releaseRoot, 'roles', record.roleId || 'default', 'prompt.md'), 'utf8'), record.prompt ? `\n用户设定的身份与职责：\n${record.prompt}` : ''].filter(Boolean).join('\n');
      config.skills = record.maintenanceFor ? [] : [...(config.skills || []).filter(path => !inside(join(appRoot, 'releases'), resolve(path))), ...(profile.skills || []).map(skill => join(releaseRoot, 'skills', skill))];
      config.bundledSkills = record.maintenanceFor ? [] : profile.skills || [];
      if (record.maintenanceFor) config.maintenanceFor = record.maintenanceFor;
    }
    config.bundleRoot = releaseRoot;
    for (const name of ['promptFile', 'agentDir']) if (config[name]) config[name] = rebase(config[name]);
    for (const name of ['skills', 'promptPaths']) if (config[name]) config[name] = config[name].map(rebase);
    config.limits = Object.fromEntries(Object.entries(config.limits || {}).filter(([key]) => ['reserveTokens', 'keepRecentTokens'].includes(key)));
    config.tools = (config.tools || []).filter(tool => !tool.name?.startsWith('codex_') && !String(tool.url || '').includes('/capabilities/codex/')).map(tool => {
      const current = { ...tool }; if (current.module) current.module = rebase(current.module);
      if (typeof current.url === 'string') current.url = current.url.replace(/\/capabilities\/([^/]+)\/versions\/([^/]+)\/tools\//, (match, id) => retained.has(decodeURIComponent(id)) ? `/capabilities/${id}/versions/${encodeURIComponent(retained.get(decodeURIComponent(id)))}/tools/` : match);
      return current;
    });
    if (record) {
      const bundled = [...toolDefinitions, ...controlTools, ...catalogTools].filter(tool => record.allowedTools.includes(tool.name));
      const names = new Set([...toolDefinitions, ...controlTools, ...catalogTools].map(tool => tool.name));
      const gatewayUrl = `http://${deployment.gateway.host || '127.0.0.1'}:${deployment.gateway.port}`;
      config.catalog = { url: gatewayUrl, token: record.capabilityToken };
      config.tools = [...bundled.map(tool => {
        const owner = capabilityForTool(tool.name);
        return { ...tool, taskContext: true, type: 'http', method: 'POST', url: owner ? `${gatewayUrl}/capabilities/${owner}/versions/${buildId}/tools/${tool.name}` : `${gatewayUrl}/tools/${tool.name}`,
          headers: { Authorization: `Bearer ${record.capabilityToken}` }, timeoutMs: bundledToolTimeout(tool.name) };
      }), ...(record.maintenanceFor || dutyOrigin(record) ? [] : config.tools.filter(tool => !names.has(tool.name)))];
      config.bundledToolNames = bundled.map(tool => tool.name);
    }
    delete config.capabilityBindingRevision; delete config.capabilityUpdateId;
    await saveJson(path, config); bots++;
    const database = join(dataRoot, 'bots', directory.name, 'state.sqlite');
    if (existsSync(database)) {
      const store = new BotStore(database);
      try { for (const record of store.listRecords('capability-updates')) store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('capability-updates', record.id); }
      finally { store.close(); }
    }
  }
  for (const [capability, kind] of [['chatroom', 'deliveries']]) {
    const path = join(dataRoot, 'capabilities', capability, 'state.sqlite'); if (!existsSync(path)) continue;
    const store = new RecordStore(path);
    try { for (const record of store.list(kind)) if (unfinished(record)) store.save(kind, { ...record, serviceVersion: buildId }); }
    finally { store.close(); }
  }
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) await removeWithin(dataRoot, join(dataRoot, 'capabilities', 'codex', name));
  const runtime = join(dataRoot, 'capabilities/service-runtime');
  for (const capability of await entries(runtime)) {
    if (!capability.isDirectory()) continue;
    for (const version of await entries(join(runtime, capability.name))) {
      if (version.name !== retained.get(capability.name)) await removeWithin(runtime, join(runtime, capability.name, version.name));
    }
    if (!retained.has(capability.name)) await removeWithin(runtime, join(runtime, capability.name));
  }
  for (const directory of await entries(join(dataRoot, 'capabilities/packages'))) if (!retained.has(directory.name)) await removeWithin(dataRoot, join(dataRoot, 'capabilities/packages', directory.name));
  for (const directory of await entries(join(appRoot, 'releases'))) if (resolve(join(appRoot, 'releases', directory.name)) !== releaseRoot) await removeWithin(appRoot, join(appRoot, 'releases', directory.name));
  // Business archives and historical user materials are not obsolete releases.
  if (sourceRoot) {
    const dist = join(sourceRoot, 'dist');
    for (const directory of await entries(dist)) if (directory.name !== 'releases') await removeWithin(sourceRoot, join(dist, directory.name));
    // A concurrent build is still writing its staging directory; it is not an obsolete release.
    for (const directory of await entries(join(dist, 'releases'))) if (directory.name !== buildId && !activeBuild(directory.name)) {
      const path = join(dist, 'releases', directory.name);
      if (deferred.has(resolve(path).toLowerCase())) cleanupDeferred.push(path); else await removeWithin(sourceRoot, path);
    }
    await removeWithin(sourceRoot, join(sourceRoot, 'scripts/migration'));
  }
  return { currentOnly: !cleanupDeferred.length, bots, releaseRoot, nativeMigration, ...(cleanupDeferred.length ? { cleanupDeferred } : {}) };
}
