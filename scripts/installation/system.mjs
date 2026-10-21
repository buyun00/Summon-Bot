import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
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

export async function initializeDeployment({ dataRoot, releaseRoot, defaultCwd, publicOrigin = '', port = 8787 } = {}) {
  dataRoot = resolve(dataRoot); releaseRoot = resolve(releaseRoot);
  if (within(releaseRoot, dataRoot) || within(dataRoot, releaseRoot)) throw new Error('Deployment code and data roots must be disjoint');
  const path = deploymentPath(dataRoot);
  if (existsSync(path)) return { created: false, configPath: path, config: await readJson(path) };
  const config = { schemaVersion: 2, dataRoot, releaseRoot, defaultCwd: resolve(defaultCwd || join(dataRoot, 'workspace')),
    runIntent: 'running', publicOrigin, gatewayToken: token(), controlToken: token(),
    environmentFile: join(dataRoot, 'config', 'runtime.env'), web: { host: '127.0.0.1', port: Number(port) },
    gateway: { host: '127.0.0.1', port: 0 },
    model: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' } };
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
    if (actual.bootId !== run.bootId || actual.pid !== run.pid || actual.type !== type) throw new Error('Service identity mismatch');
    return actual;
  } catch { return { ...run, state: 'unreachable' }; }
}

export async function launchService(config, type, { foreground = false, timeoutMs = 60000 } = {}) {
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
  const log = await open(join(logRoot, 'process.log'), 'a');
  const bundled = join(config.releaseRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const child = spawn(existsSync(bundled) ? bundled : process.execPath,
    [entry, '--type', type, '--config', deploymentPath(config.dataRoot)],
    { cwd: config.defaultCwd, env: await deploymentEnvironment(config), detached: !foreground, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, signal) => { failure = new Error(`${type} exited before readiness (${code ?? signal}); see ${logRoot}`); });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const next = await inspectService(config, type);
    if (next.state === 'ready' && next.pid === child.pid) return next;
    await pause(150);
  }
  throw new Error(`${type} is still loading; inspect its logs before retrying (PID ${child.pid})`);
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
  return { state: 'stopped', web, gateway: stoppedGateway };
}
