import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { acquireIdentityLock, inspectInstanceIdentity } from '../../bot/src/runtime/identity-lock.mjs';
import { validateServiceIdentity } from './host.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (message, code, status) => Object.assign(new Error(message), { code, status });
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export async function writePrivateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/** Owns immutable service versions, while workers survive an ordinary gateway restart. */
export class CapabilityServiceSupervisor {
  constructor({ dataRoot, releaseRoot, nodePath = process.execPath, startupTimeoutMs = 30000 }) {
    if (!dataRoot || !releaseRoot) throw new Error('Capability supervisor requires dataRoot and releaseRoot');
    this.dataRoot = resolve(dataRoot); this.releaseRoot = resolve(releaseRoot); this.nodePath = nodePath;
    this.root = join(this.dataRoot, 'capabilities', 'service-runtime');
    this.startupTimeoutMs = startupTimeoutMs;
    this.starting = new Map();
  }
  paths(id, version) {
    validateServiceIdentity(id, version);
    const root = join(this.root, id, version);
    return { root, run: join(root, 'run'), launch: join(root, 'launch'), config: join(root, 'service.json'), current: join(root, 'run', 'current.json') };
  }
  async descriptor(id, version) {
    const paths = this.paths(id, version), config = await readJson(paths.config);
    const identity = await inspectInstanceIdentity(paths.run);
    if (!identity) return config ? { id, version, state: 'stopped' } : null;
    if (!config) throw failure('Live capability has no private supervisor configuration; its ownership cannot be managed', 'SERVICE_CONFIG_MISSING', 503);
    if (identity.serviceId !== id || identity.version !== version) throw failure('Capability ownership identity does not match its directory', 'SERVICE_IDENTITY_MISMATCH');
    return { ...identity, id, version, token: config.token };
  }
  async request(id, version, path, { body, method = body === undefined ? 'GET' : 'POST', signal, timeoutMs = 30000 } = {}) {
    const descriptor = await this.descriptor(id, version);
    if (!descriptor?.url) throw failure('Capability version is not ready', 'SERVICE_NOT_READY', 503);
    const endpoint = new URL(path, descriptor.url);
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || endpoint.origin !== new URL(descriptor.url).origin) {
      throw failure('Capability request must use a service-relative path', 'INVALID_SERVICE_PATH', 400);
    }
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const requestSignal = signal && timeout ? AbortSignal.any([signal, timeout]) : signal || timeout;
    const response = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; } catch { throw failure('Capability returned invalid JSON', 'INVALID_SERVICE_RESPONSE', 502); }
    if (!response.ok) throw failure(result?.error || `Capability returned HTTP ${response.status}`, result?.code || 'SERVICE_REQUEST_FAILED', response.status);
    return result;
  }
  async status(id, version) {
    const descriptor = await this.descriptor(id, version);
    if (!descriptor?.url) return descriptor || { id, version, state: 'stopped' };
    const health = await this.request(id, version, '/health', { timeoutMs: 3000 });
    return { ...descriptor, ...health };
  }
  async list() {
    const result = [];
    for (const capability of await readdir(this.root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!capability.isDirectory()) continue;
      for (const version of await readdir(join(this.root, capability.name), { withFileTypes: true })) {
        if (version.isDirectory()) result.push(await this.status(capability.name, version.name));
      }
    }
    return result;
  }
  async start(input) {
    const { id, version } = input; validateServiceIdentity(id, version);
    const key = `${id}@${version}`;
    if (this.starting.has(key)) return this.starting.get(key);
    const operation = this.startVersion(input);
    this.starting.set(key, operation);
    try { return await operation; } finally { this.starting.delete(key); }
  }
  async startVersion({ id, version, stateVersion = '1', module, options = {} }) {
    if (typeof module !== 'string' || !module) throw new Error('Capability module path is required');
    const modulePath = module.startsWith('file:') ? fileURLToPath(module) : isAbsolute(module) ? resolve(module) : resolve(this.releaseRoot, module);
    const moduleDigest = createHash('sha256').update(await readFile(modulePath)).digest('hex');
    const paths = this.paths(id, version);
    await Promise.all([mkdir(paths.run, { recursive: true }), mkdir(paths.launch, { recursive: true })]);
    const deadline = Date.now() + this.startupTimeoutMs;
    let ownership;
    while (!ownership) {
      try { ownership = await acquireIdentityLock(paths.launch, () => ({ serviceId: id, version, pid: process.pid, state: 'launching' })); }
      catch (error) {
        if (!['INSTANCE_ALREADY_RUNNING', 'INSTANCE_LOCK_UNAVAILABLE'].includes(error.code) || Date.now() >= deadline) throw error;
        await sleep(50);
      }
    }
    try {
      const previous = await readJson(paths.config);
      if (previous && (previous.module !== modulePath || previous.stateVersion !== stateVersion || previous.moduleDigest && previous.moduleDigest !== moduleDigest)) {
        throw failure('A capability version is immutable; publish a new version for different module content or state format', 'SERVICE_VERSION_IMMUTABLE', 409);
      }
      let descriptor = await this.descriptor(id, version);
      if (descriptor?.state !== 'stopped' && descriptor) {
        for (const field of ['gatewayUrl', 'gatewayToken']) if (options[field] !== undefined && previous.options?.[field] !== options[field]) {
          throw failure('A live capability requires its original stable gateway endpoint and credential', 'SERVICE_CONTROL_ENDPOINT_CHANGED', 409);
        }
        while (!descriptor.url && Date.now() < deadline) { await sleep(50); descriptor = await this.descriptor(id, version); }
        if (!descriptor?.url) throw failure('Existing capability is still starting; its process has been preserved', 'SERVICE_START_PENDING', 503);
        const manifest = await this.request(id, version, '/manifest');
        const health = await this.request(id, version, '/health');
        if (health.state !== 'ready') throw failure(`Existing capability is ${health.state}`, 'SERVICE_NOT_READY', 409);
        return { ...descriptor, manifest, reused: true };
      }
      const savedOptions = previous ? { ...previous.options, ...Object.fromEntries(['gatewayUrl', 'gatewayToken', 'deferStart'].filter(field => options[field] !== undefined).map(field => [field, options[field]])) } : options;
      const config = { id, version, stateVersion, module: modulePath, moduleDigest, options: savedOptions, dataRoot: this.dataRoot, releaseRoot: previous?.releaseRoot || options.releaseRoot || this.releaseRoot,
        serviceRoot: paths.root, token: previous?.token || randomBytes(32).toString('hex') };
      await writePrivateJson(paths.config, config);
      const child = spawn(this.nodePath, [join(this.releaseRoot, 'capabilities/services/cli.mjs'), '--config', paths.config], {
        cwd: this.releaseRoot, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.unref();
      const ready = await new Promise((resolveReady, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(failure('Capability startup is still pending; its process has been preserved', 'SERVICE_START_PENDING', 503)), Math.max(1, deadline - Date.now()));
        const finish = (error, value) => {
          if (settled) return; settled = true; clearTimeout(timer);
          child.removeListener('message', onMessage); child.removeListener('error', onError); child.removeListener('exit', onExit);
          if (child.connected) child.disconnect();
          if (error) reject(error); else resolveReady(value);
        };
        const onMessage = message => {
          if (message?.type === 'ready') finish(null, message);
          else if (message?.type === 'error') finish(failure(message.message || 'Capability startup failed', message.code || 'SERVICE_START_FAILED'));
        };
        const onError = error => finish(error);
        const onExit = code => finish(failure(`Capability exited before readiness (${code})`, 'SERVICE_START_FAILED'));
        child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit);
      });
      descriptor = await this.descriptor(id, version);
      if (!descriptor?.url || descriptor.bootId !== ready.bootId) throw failure('Capability readiness ownership changed', 'SERVICE_IDENTITY_MISMATCH');
      return { ...descriptor, manifest: await this.request(id, version, '/manifest'), reused: false };
    } finally { await ownership.close(); }
  }
  async drain(id, version) { return this.request(id, version, '/internal/drain', { method: 'POST', body: {} }); }
  async stop(id, version, { timeoutMs = 10000, drain = false } = {}) {
    const before = await this.descriptor(id, version);
    if (!before || before.state === 'stopped') return { id, version, state: 'stopped' };
    if (!before.url) throw failure('Capability is still starting; its process has been preserved', 'SERVICE_START_PENDING', 409);
    const deadline = Date.now() + timeoutMs;
    if (drain) {
      await this.drain(id, version);
      for (;;) {
        const status = await this.status(id, version);
        if (status.state === 'stopped') return { id, version, state: 'stopped' };
        if (!status.activeRequests && !status.pendingWork) break;
        if (Date.now() >= deadline) throw failure(`${id}@${version} is still draining active work`, 'SERVICE_STOP_PENDING', 409);
        await sleep(25);
      }
    }
    await this.request(id, version, '/internal/shutdown', { method: 'POST', body: {} });
    while (Date.now() < deadline) {
      const after = await this.descriptor(id, version);
      if (after?.state === 'stopped' || !after) return { id, version, state: 'stopped' };
      if (after.bootId !== before.bootId) throw failure('Capability was restarted while waiting for its shutdown', 'SERVICE_IDENTITY_CHANGED', 409);
      await sleep(25);
    }
    throw failure('Capability shutdown is still pending; no process was killed', 'SERVICE_STOP_PENDING', 409);
  }
}
