import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson, writeJson } from '../build/files.mjs';
import { instanceOrigin } from '../../web/backend/origins.mjs';
import { instanceProof } from '../../web/backend/instance-probe.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { assertInstallationWritable } from './installation-state.mjs';

const configPath = dataRoot => join(dataRoot, 'config', 'remote-access.json');
const candidateKey = 'verifying';

export async function readRemoteAccess(dataRoot) {
  try {
    const entries = await readJson(configPath(dataRoot));
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid remote-access.json');
    return entries;
  }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function writeRemoteAccess(dataRoot, value) {
  return writeJson(configPath(dataRoot), value);
}

async function optionalRemoteAccess(dataRoot, onWarning) {
  try { return await readRemoteAccess(dataRoot); }
  catch (error) {
    onWarning?.(`Cannot read remote-access.json (${error.code || error.name})`);
    return {};
  }
}

function validEntries(entries, onWarning) {
  const result = Object.create(null);
  for (const [name, entry] of Object.entries(entries)) {
    if (name === candidateKey) continue;
    try {
      if (typeof entry?.origin !== 'string') throw new Error('Missing remote origin');
      result[name] = { ...entry, origin: instanceOrigin(entry.origin, { httpsOnly: true }) };
    } catch {
      onWarning?.(`Ignored invalid remote origin for ${name.replace(/[\r\n]/g, ' ').slice(0, 60)}`);
    }
  }
  return result;
}

export async function usableRemoteAccess(dataRoot, onWarning) {
  return validEntries(await optionalRemoteAccess(dataRoot, onWarning), onWarning);
}

export function remoteCandidate(entries) {
  const candidate = entries[candidateKey];
  return candidate?.expires > Date.now() ? candidate : null;
}

export async function remoteOrigins(dataRoot, { includeCandidates = false } = {}) {
  const entries = await optionalRemoteAccess(dataRoot);
  const result = Object.entries(validEntries(entries)).filter(([, entry]) => !entry.pending)
    .map(([provider, entry]) => ({ origin: entry.origin, provider }));
  const candidate = includeCandidates && remoteCandidate(entries);
  if (candidate && ['cloudflare', 'tailscale', 'custom'].includes(candidate.provider)) {
    try { result.push({ origin: instanceOrigin(candidate.origin, { httpsOnly: true }), provider: candidate.provider, probeOnly: true }); }
    catch {}
  }
  return result;
}

// The caller already holds the remote-access-operation lock. Regular Host
// authorization continues to use the selected entries during this probe.
export async function verifyRemoteCandidate(dataRoot, entries, candidate, operation) {
  entries[candidateKey] = { ...candidate, pending: true };
  await writeRemoteAccess(dataRoot, entries);
  try { return await operation(); }
  finally {
    delete entries[candidateKey];
    await writeRemoteAccess(dataRoot, entries);
  }
}

export async function inspectRemoteOrigin(config, origin, { signal, timeoutMs = 3000 } = {}) {
  const challenge = randomBytes(32).toString('base64url'), url = new URL('/auth/instance', origin);
  url.searchParams.set('challenge', challenge);
  try {
    const timeout = AbortSignal.timeout(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000 ? timeoutMs : 3000);
    const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return { reachable: false, status: response.status, code: 'REMOTE_HTTP_ERROR', message: '远程入口返回 HTTP ' + response.status + '。请检查代理目标及 Host 转发。' };
    const body = await response.json().catch(() => null);
    if (body?.proof !== instanceProof(config.web.accessToken, challenge)) return { reachable: false, status: response.status, code: 'REMOTE_INSTANCE_MISMATCH', message: '远程入口没有返回当前实例的身份，请检查它转发到的实例。' };
    return { reachable: true, status: response.status };
  } catch (error) {
    signal?.throwIfAborted();
    return { reachable: false, code: error.cause?.code || error.code || error.name, message: '无法连接远程入口，请检查 DNS、网络及代理连接。' };
  }
}

export async function probeRemoteOrigin(config, origin) {
  return (await inspectRemoteOrigin(config, origin)).reachable;
}

export async function registerCustomRemote(config, input, { signal } = {}) {
  await assertInstallationWritable(config.dataRoot, config.releaseRoot);
  signal?.throwIfAborted();
  const origin = instanceOrigin(input.origin, { httpsOnly: true });
  const lock = await acquireServiceLock(config.dataRoot, 'remote-access-operation', () => ({ pid: process.pid, bootId: 'custom-remote', state: 'working' }));
  try {
    await assertInstallationWritable(config.dataRoot, config.releaseRoot);
    const entries = await readRemoteAccess(config.dataRoot);
    const entry = { origin, owner: input.bridgePath ? 'summon' : 'external', label: String(input.label || '自定义远程入口').slice(0, 80),
      temporary: input.temporary === true, ...(input.bridgePath ? { bridgePath: input.bridgePath } : {}) };
    return await verifyRemoteCandidate(config.dataRoot, entries, { provider: 'custom', origin, expires: Date.now() + 120000 }, async () => {
      const startedAt = Date.now();
      let deadline = startedAt + 30000;
      let probe;
      do {
        probe = await inspectRemoteOrigin(config, origin, { signal, timeoutMs: input.probeTimeoutMs });
        if (probe.reachable) {
          entries.custom = entry;
          return { provider: 'custom', state: 'reachable', registered: true, reachable: true, ...entry };
        }
        // A newly issued tunnel hostname can lag behind the live connector.
        // Keep this same route alive while DNS and the edge become available.
        if (['ENOTFOUND', 'EAI_AGAIN'].includes(probe.code) || probe.status >= 520) deadline = startedAt + 90000;
        await pause(500, undefined, { signal });
      } while (Date.now() < deadline);
      return { provider: 'custom', state: 'unreachable', registered: false, reachable: false, origin, error: probe };
    });
  } finally { await lock.close(); }
}
