import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyTree, readJson, within, writeJson } from '../../build/files.mjs';
import { assertClientAvailability, sameAvailability } from '../../release/availability.mjs';
import { acquireServiceLock } from '../service-lock.mjs';
import { firstCutoverPath, legacyWriters } from '../legacy-writers.mjs';
import { baseline, inspect104, records } from './inspect-104.mjs';

const types = ['web', 'gateway', 'cloudflared', 'remote-bridge'];
const firstCutover = 'firstCutover104';
const businessCall = fact => !['capability-requests', 'capability-rpc'].includes(fact.kind);
const equivalent = (left, right) => typeof left === 'string' && typeof right === 'string' && relative(left, right) === '';
const optional = async file => {
  try { return await readJson(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const oldImport = (root, path) => import(pathToFileURL(join(root, path)));

async function request(url, token, path, { method = 'GET', data, timeout = 5000 } = {}) {
  const base = new URL(url);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('Legacy writer has an invalid local control endpoint');
  }
  const response = await fetch(new URL(path, base), {
    method, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Legacy writer ${method} ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function stopManaged(system, config, type) {
  for (;;) {
    const observed = await system.inspectService(config, type);
    if (observed.state === 'stopped') return;
    if (observed.state === 'ready') {
      await system.stopService(config, type);
      return;
    }
    if (observed.state !== 'stopping') throw new Error(`The legacy ${type} owner is ${observed.state}`);
    await pause(1000);
  }
}

async function stopWorker(supervisor, worker) {
  let current = worker;
  while (current.state === 'stopping') {
    await pause(1000);
    current = await supervisor.status(worker.id, worker.version);
  }
  if (current.state !== 'stopped') {
    await supervisor.stop(worker.id, worker.version, { drain: true, timeoutMs: 60000 });
  }
}

async function stopBots(config, bots) {
  const { inspectInstanceIdentity } = await oldImport(config.releaseRoot, 'bot/src/runtime/identity-lock.mjs');
  // Only the authenticated runtime owns Bot shutdown. Direct use preserves
  // management runIntent; gateway and worker processes have already exited.
  const results = await Promise.allSettled(bots.map(async bot => {
    const identity = await inspectInstanceIdentity(bot.directory);
    if (!identity) return;
    if (identity.bootId !== bot.bootId) throw new Error(`Legacy Bot ${bot.botId} was replaced during cutover`);
    if (identity.state === 'ready') {
      const result = await request(bot.url, bot.token, '/shutdown', { method: 'POST', data: {} });
      if (!result.stopping || result.bootId !== bot.bootId) throw new Error(`Legacy Bot ${bot.botId} did not acknowledge shutdown`);
    } else if (identity.state !== 'stopping') {
      throw new Error(`Legacy Bot ${bot.botId} is ${identity.state}`);
    }
    for (;;) {
      const current = await inspectInstanceIdentity(bot.directory);
      if (!current) return;
      if (current.bootId !== bot.bootId) throw new Error(`Legacy Bot ${bot.botId} was replaced during shutdown`);
      await pause(500);
    }
  }));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
  if (failures.length) throw new Error(failures.join('\n'));
}

async function botsForShutdown(config) {
  const { inspectInstanceIdentity } = await oldImport(config.releaseRoot, 'bot/src/runtime/identity-lock.mjs');
  const bots = [];
  for (const entry of await readdir(join(config.dataRoot, 'bots'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(config.dataRoot, 'bots', entry.name);
    const found = await inspectInstanceIdentity(directory);
    if (!found) continue;
    if (!['ready', 'stopping'].includes(found.state) || found.botId !== entry.name) {
      throw new Error(`Legacy Bot ${entry.name} is ${found.state}; its ownership must settle`);
    }
    const bot = await readJson(join(directory, 'config.json'));
    const health = await request(found.url, bot.token, '/health');
    if (health.pid !== found.pid || health.bootId !== found.bootId || health.botId !== bot.botId || bot.botId !== entry.name) {
      throw new Error(`Legacy Bot ${entry.name} ownership changed`);
    }
    bots.push({ directory, botId: entry.name, token: bot.token, url: found.url, bootId: found.bootId,
      accepting: typeof bot.accepting === 'boolean' ? bot.accepting : null, health });
  }
  return bots;
}

function activeInBots(bots) {
  const result = [];
  for (const bot of bots) {
    const { engine } = bot.health;
    if (!Array.isArray(engine?.active) || !Number.isInteger(engine.maintenanceActive)) throw new Error(`Legacy Bot ${bot.botId} activity is unavailable`);
    for (const { taskId } of engine.active) result.push({ kind: 'bot-task', id: `${bot.botId}:${taskId}`, status: 'running' });
    if (engine.maintenanceActive) result.push({ kind: 'bot-maintenance', id: bot.botId, status: 'running' });
    if (engine.capabilitySwitchPending) result.push({ kind: 'bot-tool-switch', id: bot.botId, status: 'pending' });
  }
  return result;
}

async function legacyModelLogins(config, gateway) {
  const paths = [null, ...recordsOfWorkspaceIds(config.dataRoot)];
  const active = [];
  for (const workspace of paths) {
    const file = workspace ? join(config.dataRoot, 'config', 'workspaces', workspace, 'model-connections.json')
      : join(config.dataRoot, 'config', 'model-connections.json');
    const catalog = await optional(file);
    for (const connection of catalog?.connections || []) {
      if (!['codex', 'grok'].includes(connection.kind) || ['codex-local', 'grok-local'].includes(connection.authMode)) continue;
      const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
      const result = await request(gateway.url, config.gatewayToken,
        `/api/model-settings/connections/${encodeURIComponent(connection.id)}/login${query}`);
      if (['starting', 'waiting'].includes(result.status)) {
        active.push({ kind: 'model-login', id: `${workspace || 'main'}:${connection.id}`, status: result.status });
      }
    }
  }
  return active;
}

const recordsOfWorkspaceIds = dataRoot => records(join(dataRoot, 'capabilities', 'gateway', 'state.sqlite'), 'workspace-profiles')
  .filter(row => /^[a-zA-Z0-9_.-]+$/.test(row.id) && !['.', '..'].includes(row.id)).map(row => row.id);

async function recordStarted(marker, facts, save) {
  const known = new Map(marker.started_calls.map(call => [JSON.stringify([call.kind, call.id]), call]));
  const before = known.size;
  for (const { kind, id } of facts.filter(businessCall)) known.set(JSON.stringify([kind, id]), { kind, id });
  if (before !== known.size) {
    marker.started_calls = [...known.values()];
    await save();
  }
}

async function waitFor104Boundary(config, supervisor, marker, save) {
  for (;;) {
    const facts = await inspect104(config.dataRoot, { since: marker.began_at });
    const bots = await botsForShutdown(config);
    if (bots.some(bot => bot.accepting !== false)) throw new Error('A legacy Bot has reopened message intake during cutover');
    const workers = supervisor ? await supervisor.list() : [];
    const active = [...facts.active, ...activeInBots(bots)];
    for (const worker of workers) {
      if (!['ready', 'stopped', 'draining'].includes(worker.state) || worker.activeRequests) {
        active.push({ kind: 'capability-rpc', id: `${worker.id}@${worker.version}`, status: worker.state });
      }
    }
    await recordStarted(marker, [...active, ...facts.started], save);
    if (active.length) { await pause(1500); continue; }
    if (facts.armed.length) {
      const summary = facts.armed.map(call => `${call.kind}:${call.id}`).slice(0, 8).join(', ');
      throw new Error(`Legacy 0.3.100 still has ${facts.armed.length} runnable or unconfirmed producer(s): ${summary}`);
    }
    return bots;
  }
}

export async function switch104({ appRoot, dataRoot, container, releaseRoot, clientAvailability }) {
  if (process.platform !== 'win32') throw new Error('The installed build 104 handoff is specific to Windows');
  appRoot = await realpath(appRoot);
  dataRoot = await realpath(dataRoot);
  container = await realpath(container);
  if (within(appRoot, container) || within(dataRoot, container) || within(container, appRoot) || within(container, dataRoot)) {
    throw new Error('Use a build container outside the application and data directories');
  }
  const manifest = await readJson(join(container, 'release-manifest.json'));
  if (manifest[firstCutover] !== true || manifest.sourceCommit !== baseline || manifest.dataFormat ||
      !/^first-cutover-104-[a-f0-9-]{36}$/.test(manifest.buildId)) throw new Error('Prepare the 0.3.100 handoff container first');
  const destination = join(appRoot, 'releases', manifest.buildId);
  if (!within(appRoot, await realpath(dirname(destination)))) throw new Error('The installed releases directory is outside the application');
  const deploymentFile = join(dataRoot, 'config', 'deployment.json');
  const selectionFile = join(appRoot, 'current.json');
  const markerFile = firstCutoverPath(dataRoot);
  const bootId = randomUUID();
  const owner = await acquireServiceLock(dataRoot, 'installation', () => ({ pid: process.pid, bootId, state: 'installing' }));
  try {
    if (await optional(join(dataRoot, 'config', 'installation_state.json'))) throw new Error('Continue the selected main installer');
    let config = await readJson(deploymentFile);
    let marker = await optional(markerFile);
    const save = () => writeJson(markerFile, marker);
    const target = await readJson(join(releaseRoot, 'release-manifest.json'));
    if (target.format !== 3 || target.dataFormat !== 2 || target.application !== 'summon-bot' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.buildId) ||
        !Number.isSafeInteger(target.protocolVersion) || !Number.isSafeInteger(target.buildNumber)) {
      throw new Error('Provide the committed R2 installation candidate before closing intake');
    }
    if (!equivalent(config.dataRoot, dataRoot) || !within(join(appRoot, 'releases'), await realpath(config.releaseRoot))) {
      throw new Error('Invalid installed deployment paths');
    }
    if (!marker) {
      if (!sameAvailability(clientAvailability, dataRoot, target)) {
        await assertClientAvailability({ dataRoot, release: await readJson(join(releaseRoot, 'release.json')), expected: target });
      }
      const current = await readJson(selectionFile);
      if (!equivalent(config.releaseRoot, current.releaseRoot)) throw new Error('The deployment and application selection disagree');
      const oldManifest = await readJson(join(config.releaseRoot, 'release-manifest.json'));
      const release = await readJson(join(config.releaseRoot, 'release.json'));
      if (oldManifest.sourceCommit !== baseline || oldManifest[firstCutover] || oldManifest.contentHash || oldManifest.dataFormat ||
          release.version !== '0.3.100' || release.buildNumber !== 104) throw new Error('Expected the installed 0.3.100 build 104');
      const installed = await optional(join(destination, 'release-manifest.json'));
      if (!installed) {
        const staging = destination + '.installing';
        await mkdir(staging, { recursive: true });
        await copyTree(container, staging);
        await rename(staging, destination);
      } else if (installed.buildId !== manifest.buildId || installed[firstCutover] !== true) {
        throw new Error('Handoff build ID belongs to a different container');
      }
      const beganAt = new Date().toISOString();
      const facts = await inspect104(dataRoot);
      const active = facts.active.filter(businessCall);
      if (facts.armed.length || active.length) {
        const causes = [...active, ...facts.armed].slice(0, 8).map(fact => `${fact.kind}:${fact.id}`).join(', ');
        throw new Error(`Legacy 0.3.100 still owns active work or a producer that cannot be paused independently (${causes})`);
      }
      marker = { schemaVersion: 1, id: randomUUID(), phase: 'prepared', began_at: beganAt, previousIntent: config.runIntent, target_build: target.buildId,
        previous_release: config.releaseRoot, handoff_release: destination, started_calls: [] };
      await save();
    } else if (marker.target_build !== target.buildId || !equivalent(marker.handoff_release, destination) ||
        ![marker.previous_release, destination].some(path => equivalent(config.releaseRoot, path))) {
      throw new Error('Continue the existing first-cutover with its staged container');
    }

    if (!within(join(appRoot, 'releases'), await realpath(marker.previous_release))) throw new Error('The original release is outside the application');
    const previous = { ...config, releaseRoot: marker.previous_release };
    const oldSystem = await oldImport(previous.releaseRoot, 'scripts/installation/system.mjs');
    const { CapabilityServiceSupervisor } = await oldImport(previous.releaseRoot, 'capabilities/services/supervisor.mjs');
    const supervisor = new CapabilityServiceSupervisor({ dataRoot, releaseRoot: previous.releaseRoot });
    if (marker.phase === 'prepared') {
      const originalOwner = legacyWriters(previous, appRoot);
      const gateway = await originalOwner.gateway();
      if (gateway.state !== 'ready') throw new Error(`The old gateway is ${gateway.state}; cannot establish its producer boundary`);
      const logins = await legacyModelLogins(previous, gateway);
      const readyBots = await botsForShutdown(previous);
      if (logins.length || activeInBots(readyBots).length) throw new Error('The old runtime still owns a model login or an active Bot operation');
      if (config.runIntent !== 'stopped') {
        config = { ...config, runIntent: 'stopped' };
        await writeJson(deploymentFile, config);
      }
      await stopManaged(oldSystem, config, 'web');
      for (const worker of await supervisor.list()) if (worker.state === 'ready' && worker.id === 'chatroom') {
        await supervisor.request(worker.id, worker.version, '/rpc/pause', { body: { arguments: [] }, timeoutMs: 180000 });
      }
      for (const worker of await supervisor.list()) if (worker.state === 'ready' && worker.id === 'bot-management') {
        await supervisor.request(worker.id, worker.version, '/rpc/quiesce', { body: { arguments: [] }, timeoutMs: 180000 });
      }
      const bots = await botsForShutdown(previous);
      const original = new Map(Object.entries(marker.original_accepting || {}));
      for (const bot of bots) if (!original.has(bot.botId)) original.set(bot.botId, bot.accepting);
      marker.original_accepting = Object.fromEntries(original);
      await save();
      for (const bot of bots) {
        if (bot.health.state !== 'ready') throw new Error(`Legacy Bot ${bot.botId} is ${bot.health.state}`);
        const result = await request(bot.url, bot.token, '/availability', { method: 'PATCH', data: { accepting: false } });
        if (result.accepting !== false) throw new Error(`Legacy Bot ${bot.botId} did not close message intake`);
      }
      marker.phase = 'intake_closed';
      await save();
    }

    if (marker.phase === 'intake_closed') {
      if (config.runIntent !== 'stopped') throw new Error('The old deployment has been restarted during cutover');
      await waitFor104Boundary(previous, supervisor, marker, save);
      const gateway = await legacyWriters(previous, appRoot).gateway();
      if (gateway.state === 'ready' && (await legacyModelLogins(previous, gateway)).length) {
        throw new Error('The legacy gateway still has a model authorization in progress');
      }
      // The original gateway close prevents further entry and awaits requests.
      // Leave Bots up until this producer, its native poller and capability
      // workers have exited. An already-accepted input can then finish locally.
      await stopManaged(oldSystem, previous, 'gateway');
      for (const worker of await supervisor.list()) await stopWorker(supervisor, worker);
      marker.phase = 'producers_stopped';
      await save();
    }

    if (marker.phase === 'producers_stopped') {
      const bots = await waitFor104Boundary(previous, null, marker, save);
      if (!marker.cutoff) {
        marker.cutoff = new Date().toISOString();
        await save();
      }
      await stopBots(previous, bots);
      marker.phase = 'bots_stopped';
      await save();
    }

    if (marker.phase === 'bots_stopped') {
      for (const type of types.filter(type => type !== 'gateway')) await stopManaged(oldSystem, previous, type);
      for (;;) {
        try { await legacyWriters(previous, appRoot).assertStopped(); break; }
        catch (error) {
          if (error.code !== 'INSTALLATION_ACTIVE_WRITER') throw error;
          await pause(2000);
        }
      }
      const facts = await inspect104(dataRoot, { since: marker.cutoff });
      if (facts.active.length || facts.started.some(businessCall)) throw new Error('Old runtime stopped with unconfirmed active receipts or business calls started after cutoff');
      for (const [botId, accepting] of Object.entries(marker.original_accepting || {})) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(botId)) throw new Error('Invalid Bot restoration identity');
        const path = join(dataRoot, 'bots', botId, 'config.json');
        const saved = await readJson(path);
        if (saved.botId !== botId) throw new Error('Legacy Bot configuration ownership changed');
        if (accepting === null) delete saved.accepting; else saved.accepting = accepting;
        await writeJson(path, saved);
      }
      delete marker.original_accepting;
      marker.phase = 'writers_stopped';
      await save();
    }

    if (!['writers_stopped', 'handoff_selected'].includes(marker.phase)) throw new Error('Unknown first-cutover phase');
    config = { ...await readJson(deploymentFile), releaseRoot: destination, runIntent: 'stopped' };
    await writeJson(deploymentFile, config);
    marker.phase = 'handoff_selected';
    marker.selectedAt ||= new Date().toISOString();
    await writeJson(selectionFile, { schemaVersion: 1, releaseRoot: destination, buildId: manifest.buildId, dataRoot,
      selectedAt: marker.selectedAt });
    await save();
    const handoff = await oldImport(destination, 'scripts/installation/system.mjs');
    const gateway = await handoff.launchService(config, 'gateway');
    await handoff.launchService(config, 'web');
    if (marker.previousIntent === 'running') {
      const { restoreAuxiliaries } = await oldImport(destination, 'scripts/installation/auxiliaries.mjs');
      await restoreAuxiliaries(config);
    }
    const endpoint = await request(gateway.controlUrl, config.controlToken, '/installation');
    if (!endpoint.supportsDrain || endpoint.bootId !== gateway.bootId || endpoint.pid !== gateway.pid) throw new Error('Handoff gateway did not confirm the drain interface');
    return { migration_id: marker.id, buildId: manifest.buildId, releaseRoot: destination, state: 'handoff_selected' };
  } finally { await owner.close(); }
}

export async function resume104({ appRoot, dataRoot, state }) {
  const marker = await readJson(firstCutoverPath(dataRoot));
  const config = await readJson(join(dataRoot, 'config', 'deployment.json'));
  const selected = await readJson(join(appRoot, 'current.json'));
  if (!state || !['prepared', 'draining'].includes(state.phase) ||
      state.migration_id !== marker.id || marker.target_build !== state.target_build ||
      marker.phase !== 'handoff_selected' || config.runIntent !== 'stopped' ||
      !equivalent(state.previous_release, marker.handoff_release) ||
      !equivalent(config.releaseRoot, marker.handoff_release) || !equivalent(selected.releaseRoot, marker.handoff_release)) {
    throw new Error('The selected legacy handoff cannot resume this installation phase');
  }
  const handoff = await oldImport(config.releaseRoot, 'scripts/installation/system.mjs');
  await handoff.launchService(config, 'gateway');
  if (!state.intake_closed) await handoff.launchService(config, 'web');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [appRoot, dataRoot, container, releaseRoot] = process.argv.slice(2);
    if (!appRoot || !dataRoot || !container || !releaseRoot) {
      throw new Error('Usage: node switch-104.mjs <app-root> <data-root> <prepared-container> <committed-R2-release>');
    }
    console.log(JSON.stringify(await switch104({ appRoot, dataRoot, container, releaseRoot })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
