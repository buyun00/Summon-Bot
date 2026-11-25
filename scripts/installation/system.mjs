import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson, writeJson, within } from './files.mjs';
import { inspectServiceLock } from './service-lock.mjs';
import { assertInstallationWritable, dataFormat } from './installation-state.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';

export const deploymentPath = dataRoot => join(resolve(dataRoot), 'config', 'deployment.json');
export const serviceFolders = { web: 'web', gateway: 'capabilities/gateway', cloudflared: 'connectors/cloudflared', 'remote-bridge': 'connectors/remote-bridge' };
export const serviceRoot = (dataRoot, type) => join(dataRoot, serviceFolders[type]);
export const serviceRunPath = (dataRoot, type) => join(serviceRoot(dataRoot, type), 'run', 'current.json');
export const bundledNode = releaseRoot => join(releaseRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const token = () => randomBytes(32).toString('base64url');
const transientStartupHandshake = error => error.code === 'SERVICE_IDENTITY_UNAVAILABLE'
  && ['SERVICE_HANDSHAKE_TIMEOUT', 'SERVICE_HANDSHAKE_INCOMPLETE', 'ECONNRESET', 'EPIPE'].includes(error.cause?.code);

export function createDeployment({ dataRoot, releaseRoot, defaultCwd, port = 8787 } = {}) {
  dataRoot = resolve(dataRoot); releaseRoot = resolve(releaseRoot);
  if (within(releaseRoot, dataRoot) || within(dataRoot, releaseRoot)) throw new Error('Deployment code and data roots must be disjoint');
  return { schemaVersion: 4, dataFormat, dataRoot, releaseRoot, defaultCwd: resolve(defaultCwd || join(dataRoot, 'workspace')),
    runIntent: 'running', gatewayToken: token(), controlToken: token(),
    environmentFile: join(dataRoot, 'config', 'runtime.env'), web: { host: '127.0.0.1', port: Number(port), accessToken: token() },
    gateway: { host: '127.0.0.1', port: 0 } };
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
  const merged = { ...values, ...process.env };
  if (process.platform === 'darwin') {
    const home = homedir();
    const extraPaths = [
      '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
      join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'), join(home, '.bun', 'bin'),
    ];
    const current = String(merged.PATH || '').split(delimiter).filter(Boolean);
    const augmented = [...new Set([...current, ...extraPaths.filter(dir => existsSync(dir))])];
    merged.PATH = augmented.join(delimiter);
  }
  return merged;
}

export async function inspectService(config, type) {
  const locked = await inspectServiceLock(config.dataRoot, type);
  if (!locked) return { type, state: 'stopped' };
  if (locked.state === 'starting') return locked;
  const run = locked;
  if (!run.controlUrl || !['127.0.0.1', '[::1]'].includes(new URL(run.controlUrl).hostname)) throw new Error(`Invalid ${type} control address`);
  try {
    const response = await fetch(new URL('/health', run.controlUrl), { redirect: 'error', headers: { Authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const actual = await response.json();
    if (actual.bootId !== run.bootId || actual.pid !== run.pid || actual.type !== type) throw Object.assign(new Error('Service identity mismatch'), { code: 'SERVICE_IDENTITY_MISMATCH' });
    return actual;
  } catch (error) { if (error.code === 'SERVICE_IDENTITY_MISMATCH') throw error; return { ...run, state: 'unreachable' }; }
}

export async function launchService(config, type, { foreground = false, timeoutMs = 180000, onExit, signal } = {}) {
  signal?.throwIfAborted();
  if (config.dataFormat !== dataFormat) throw new Error('Use the selected release launcher for the existing deployment');
  await assertInstallationWritable(config.dataRoot, config.releaseRoot);
  const current = await inspectService(config, type);
  signal?.throwIfAborted();
  if (current.state === 'ready') {
    if (resolve(current.releaseRoot) !== resolve(config.releaseRoot)) throw new Error(`${type} still runs another release; stop it before switching`);
    return current;
  }
  if (current.state !== 'stopped') throw new Error(`${type} identity is ${current.state}; refusing to launch a duplicate`);
  const entry = join(config.releaseRoot, 'scripts/installation/service.mjs');
  if (!existsSync(entry)) throw new Error(`Missing service entry: ${entry}`);
  const logRoot = join(serviceRoot(config.dataRoot, type), 'logs');
  const bundled = bundledNode(config.releaseRoot);
  const env = await deploymentEnvironment(config);
  await assertInstallationWritable(config.dataRoot, config.releaseRoot);
  const child = spawn(existsSync(bundled) ? bundled : process.execPath,
    [entry, '--type', type, '--config', deploymentPath(config.dataRoot)],
    { cwd: config.releaseRoot, env, detached: !foreground, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let failure, stopping;
  const abort = () => { stopping ||= terminateTree(child); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
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
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (next && next.state !== 'stopped' && next.pid !== child.pid) throw Object.assign(new Error(`${type} startup identity belongs to another process`), { code: 'SERVICE_IDENTITY_MISMATCH' });
      if (Date.now() >= deadline) break;
      if (next?.state === 'ready') return next;
      await pause(Math.min(150, deadline - Date.now()));
    }
    if (failure) throw failure;
    throw Object.assign(new Error(`${type} did not become ready before the startup deadline; inspect its identity and logs before retrying (PID ${child.pid})`, { cause: lastHandshakeError }), { code: 'SERVICE_STARTUP_TIMEOUT' });
  } finally {
    signal?.removeEventListener('abort', abort);
    if (stopping) await stopping;
    if (child.connected) child.disconnect();
  }
}

export async function startSystem(config, { foreground = false, respectIntent = false, onProgress } = {}) {
  config = await readJson(deploymentPath(config.dataRoot));
  await assertInstallationWritable(config.dataRoot, config.releaseRoot);
  if (config.dataFormat !== dataFormat) throw new Error('Use the selected release launcher for the existing deployment');
  if (respectIntent && config.runIntent === 'stopped') return { state: 'stopped', reason: 'saved-stop-intent' };
  if (config.runIntent === 'stopped') { config = { ...config, runIntent: 'running' }; await writeJson(deploymentPath(config.dataRoot), config); }
  onProgress?.({ stage: 'gateway' });
  const gateway = await launchService(config, 'gateway', { foreground });
  onProgress?.({ stage: 'web' });
  const web = await launchService(config, 'web', { foreground });
  return { state: 'ready', gateway, web };
}

export async function stopService(config, type, { timeoutMs = 60000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let owner, last, requested = false, shutdownError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    last = await inspectService(config, type);
    if (last.state === 'stopped') return last;
    if (!last.releaseRoot || resolve(last.releaseRoot) !== resolve(config.releaseRoot)) {
      throw new Error(`${type} owner PID ${last.pid} belongs to another release (${last.releaseRoot || 'unknown'})`);
    }
    if (owner && (last.pid !== owner.pid || last.bootId !== owner.bootId)) {
      throw new Error(`${type} owner changed from PID ${owner.pid} to PID ${last.pid} during shutdown`);
    }
    owner ||= last;
    signal?.throwIfAborted();
    if (last.state === 'ready' && !requested) {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())));
      const response = await fetch(new URL('/shutdown', last.controlUrl), { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.controlToken}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
        .catch(error => { signal?.throwIfAborted(); shutdownError = error; return null; });
      if (response) {
        if (!response.ok || (await response.json()).bootId !== owner.bootId) throw new Error(`${type} PID ${owner.pid} did not accept shutdown (HTTP ${response.status})`);
        requested = true;
      }
    }
    await pause(Math.max(0, Math.min(250, deadline - Date.now())), undefined, { signal });
  }
  throw Object.assign(new Error(`${type} PID ${last?.pid ?? 'unknown'} still owns the service (${last?.state ?? 'unknown'}); resume after this owner exits or its control endpoint responds`,
    { cause: shutdownError }), { code: 'SERVICE_SHUTDOWN_TIMEOUT' });
}

export async function stopSystem(config) {
  config = await readJson(deploymentPath(config.dataRoot));
  await assertInstallationWritable(config.dataRoot, config.releaseRoot);
  if (config.dataFormat !== dataFormat) throw new Error('Use the selected release launcher for the existing deployment');
  await writeJson(deploymentPath(config.dataRoot), { ...config, runIntent: 'stopped' });
  const web = await stopService(config, 'web');
  const gateway = await stopService(config, 'gateway');
  const auxiliaries = [];
  for (const type of ['cloudflared', 'remote-bridge']) auxiliaries.push(await stopService(config, type));
  return { state: 'stopped', web, gateway, auxiliaries };
}
