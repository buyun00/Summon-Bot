import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, within } from '../build/files.mjs';
import { inspectServiceLock } from './service-lock.mjs';

const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
export const deploymentPath = dataRoot => join(resolve(dataRoot), 'config', 'deployment.json');
export const serviceRunPath = (dataRoot, type) => join(dataRoot, type === 'web' ? 'web' : 'capabilities/gateway', 'run', 'current.json');
const token = () => randomBytes(32).toString('base64url');
const transientStartupHandshake = error => error.code === 'SERVICE_IDENTITY_UNAVAILABLE'
  && ['SERVICE_HANDSHAKE_TIMEOUT', 'SERVICE_HANDSHAKE_INCOMPLETE', 'ECONNRESET', 'EPIPE'].includes(error.cause?.code);

export async function initializeDeployment({ dataRoot, releaseRoot, defaultCwd, publicOrigin = '', port = 8787 } = {}) {
  dataRoot = resolve(dataRoot); releaseRoot = resolve(releaseRoot);
  if (within(releaseRoot, dataRoot) || within(dataRoot, releaseRoot)) throw new Error('Deployment code and data roots must be disjoint');
  const path = deploymentPath(dataRoot);
  if (existsSync(path)) return { created: false, configPath: path, config: await readJson(path) };
  const config = { schemaVersion: 2, dataRoot, releaseRoot, defaultCwd: resolve(defaultCwd || join(dataRoot, 'workspace')),
    runIntent: 'running', publicOrigin, gatewayToken: token(), controlToken: token(),
    environmentFile: join(dataRoot, 'config', 'runtime.env'), web: { host: '127.0.0.1', port: Number(port) },
    gateway: { host: '127.0.0.1', port: 0 },
    model: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', contextWindow: 1048576, maxTokens: 393216, thinkingLevel: 'high' } };
  await mkdir(config.defaultCwd, { recursive: true });
  await writeJson(path, config);
  return { created: true, configPath: path, config };
}

export async function deploymentEnvironment(config) {
  const values = {};
  if (config.environmentFile && existsSync(config.environmentFile)) {
    for (const line of (await readFile(config.environmentFile, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  }
  return { ...values, ...process.env };
}

export async function inspectService(config, type) {
  const locked = await inspectServiceLock(config.dataRoot, type);
  if (!locked) return { type, state: 'stopped' };
  if (locked.state === 'starting') return locked;
  let run;
  run = locked;
  if (!run.controlUrl || !['127.0.0.1', '[::1]'].includes(new URL(run.controlUrl).hostname)) throw new Error(`Invalid ${type} control address`);
  try {
    const response = await fetch(new URL('/health', run.controlUrl), { headers: { Authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const actual = await response.json();
    if (actual.bootId !== run.bootId || actual.pid !== run.pid || actual.type !== type) throw Object.assign(new Error('Service identity mismatch'), { code: 'SERVICE_IDENTITY_MISMATCH' });
    return actual;
  } catch (error) { if (error.code === 'SERVICE_IDENTITY_MISMATCH') throw error; return { ...run, state: 'unreachable' }; }
}

export async function launchService(config, type, { foreground = false, timeoutMs = 180000, onExit } = {}) {
  const current = await inspectService(config, type);
  if (current.state === 'ready') {
    if (resolve(current.releaseRoot) !== resolve(config.releaseRoot)) throw new Error(`${type} still runs another release; stop it before switching`);
    return current;
  }
  if (current.state !== 'stopped') throw new Error(`${type} identity is ${current.state}; refusing to launch a duplicate`);
  const entry = join(config.releaseRoot, 'scripts/installation/service.mjs');
  if (!existsSync(entry)) throw new Error(`Missing service entry: ${entry}`);
  const logRoot = join(config.dataRoot, type === 'web' ? 'web' : 'capabilities/gateway', 'logs');
  await mkdir(logRoot, { recursive: true });
  const bundled = join(config.releaseRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const child = spawn(existsSync(bundled) ? bundled : process.execPath,
    [entry, '--type', type, '--config', deploymentPath(config.dataRoot)],
    { cwd: config.defaultCwd, env: await deploymentEnvironment(config), detached: !foreground, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, signal) => { failure ||= new Error(`${type} exited before readiness (${code ?? signal}); see ${logRoot}`); onExit?.(code, signal); });
  child.on('message', message => {
    if (message.type === 'error') failure = Object.assign(new Error(message.message), { code: message.code });
    if (['ready', 'error'].includes(message.type) && child.connected) child.disconnect();
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let lastHandshakeError;
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure;
      let next;
      try { next = await inspectService(config, type); }
      catch (error) {
        if (failure) throw failure;
        // Only re-observe the child we already spawned. Uncertain ownership is
        // never permission to spawn again or to report successful startup.
        if (!transientStartupHandshake(error)) throw error;
        lastHandshakeError = error;
      }
      if (failure) throw failure;
      if (next && next.state !== 'stopped' && next.pid !== child.pid) throw Object.assign(new Error(`${type} startup identity belongs to another process`), { code: 'SERVICE_IDENTITY_MISMATCH' });
      if (Date.now() >= deadline) break;
      if (next?.state === 'ready') return next;
      await pause(Math.min(150, deadline - Date.now()));
    }
    if (failure) throw failure;
    throw Object.assign(new Error(`${type} did not become ready before the startup deadline; inspect its identity and logs before retrying (PID ${child.pid})`, { cause: lastHandshakeError }), { code: 'SERVICE_STARTUP_TIMEOUT' });
  } finally { if (child.connected) child.disconnect(); }
}

export async function startSystem(config, { foreground = false, respectIntent = false } = {}) {
  config = await readJson(deploymentPath(config.dataRoot));
  if (respectIntent && config.runIntent === 'stopped') return { state: 'stopped', reason: 'saved-stop-intent' };
  if (config.runIntent === 'stopped') { config = { ...config, runIntent: 'running' }; await writeJson(deploymentPath(config.dataRoot), config); }
  const gateway = await launchService(config, 'gateway', { foreground });
  const web = await launchService(config, 'web', { foreground });
  return { state: 'ready', gateway, web };
}

export async function stopService(config, type) {
  const run = await inspectService(config, type);
  if (run.state === 'stopped') return run;
  if (run.state !== 'ready') throw new Error(`${type} cannot be safely stopped while ${run.state}`);
  const response = await fetch(new URL('/shutdown', run.controlUrl), { method: 'POST', headers: { Authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${type} rejected shutdown (${response.status})`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const next = await inspectService(config, type);
    if (next.state === 'stopped') return next;
    if (next.bootId !== run.bootId) throw new Error(`${type} was replaced by another process during shutdown`);
    await pause(100);
  }
  throw new Error(`${type} acknowledged shutdown but has not stopped`);
}

export async function stopSystem(config) {
  config = await readJson(deploymentPath(config.dataRoot));
  await writeJson(deploymentPath(config.dataRoot), { ...config, runIntent: 'stopped' });
  const gateway = await inspectService(config, 'gateway');
  if (gateway.state === 'ready') {
    const response = await fetch(new URL('/internal/bots/stop-all', gateway.url), { method: 'POST', headers: { Authorization: `Bearer ${config.gatewayToken}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Bot shutdown failed (${response.status}); services remain available for inspection`);
  } else if (gateway.state !== 'stopped') throw new Error('Gateway unreachable; inspect active Bots before stopping the system');
  else {
    // A crashed gateway must not strand independently running Bots.
    // Stop producers before stopping their consumers. These private service
    // endpoints remain usable without the gateway; no stale PID is killed.
    const supervisor = await capabilitySupervisor(config);
    if (supervisor) {
      const services = await supervisor.list();
      for (const id of ['chatroom', 'codex', 'bot-management']) for (const service of services.filter(item => item.id === id && item.state !== 'stopped')) {
        await supervisor.request(service.id, service.version, `/rpc/${id === 'bot-management' ? 'quiesce' : 'pause'}`, { body: { arguments: [] }, timeoutMs: 180000 });
      }
    }
    const { RecordStore } = await import(pathToFileURL(join(config.releaseRoot, 'capabilities/shared/store.mjs')));
    const { BotManager } = await import(pathToFileURL(join(config.releaseRoot, 'capabilities/bot-management/service.mjs')));
    const path = join(config.dataRoot, 'capabilities/bot-management/state.sqlite');
    if (existsSync(path)) {
      const store = new RecordStore(path);
      try { await new BotManager({ store, dataRoot: config.dataRoot, releaseRoot: config.releaseRoot }).shutdownAll(); }
      finally { store.close(); }
    }
  }
  const web = await stopService(config, 'web');
  const stoppedGateway = await stopService(config, 'gateway');
  const supervisor = await capabilitySupervisor(config), capabilities = [];
  if (supervisor) for (const service of await supervisor.list()) capabilities.push(await supervisor.stop(service.id, service.version));
  return { state: 'stopped', web, gateway: stoppedGateway, capabilities };
}

async function capabilitySupervisor(config) {
  const modulePath = join(config.releaseRoot, 'capabilities/services/supervisor.mjs');
  if (!existsSync(modulePath)) return null; // Initial upgrade from the old layout.
  const { CapabilityServiceSupervisor } = await import(pathToFileURL(modulePath));
  return new CapabilityServiceSupervisor({dataRoot:config.dataRoot,releaseRoot:config.releaseRoot});
}
