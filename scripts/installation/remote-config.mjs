import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson, writeJson } from '../build/files.mjs';
import { workspaceOrigin } from '../../web/backend/origins.mjs';
import { workspaceProof } from '../../web/backend/workspace-probe.mjs';
import { acquireServiceLock } from './service-lock.mjs';

const configPath = dataRoot => join(dataRoot, 'config', 'remote-access.json');

export async function readRemoteAccess(dataRoot) {
  try { return await readJson(configPath(dataRoot)); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function writeRemoteAccess(dataRoot, value) {
  return writeJson(configPath(dataRoot), value);
}

export async function migratePublicOrigin(dataRoot, publicOrigin) {
  if (!publicOrigin) return;
  const access = await readRemoteAccess(dataRoot);
  if (!access.cloudflare) {
    access.cloudflare = { origin: workspaceOrigin(publicOrigin, { httpsOnly: true }), owner: 'external' };
    await writeRemoteAccess(dataRoot, access);
  }
}

export async function remoteOrigins(dataRoot) {
  return Object.values(await readRemoteAccess(dataRoot)).filter(entry => entry?.origin && !entry.pending)
    .map(entry => workspaceOrigin(entry.origin, { httpsOnly: true }));
}

export async function inspectRemoteOrigin(config, origin, { signal } = {}) {
  const challenge = randomBytes(32).toString('base64url'), url = new URL('/auth/instance', origin);
  url.searchParams.set('challenge', challenge);
  try {
    const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
    if (!response.ok) return { reachable: false, status: response.status, code: 'REMOTE_HTTP_ERROR', message: '远程入口返回 HTTP ' + response.status + '。请检查代理目标及 Host 转发。' };
    const body = await response.json().catch(() => null);
    if (body?.proof !== workspaceProof(config.web.accessToken, challenge)) return { reachable: false, status: response.status, code: 'REMOTE_INSTANCE_MISMATCH', message: '远程入口没有返回当前工作区的身份，请检查它转发到的实例。' };
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
  signal?.throwIfAborted();
  const origin = workspaceOrigin(input.origin, { httpsOnly: true });
  const lock = await acquireServiceLock(config.dataRoot, 'remote-access-operation', () => ({ pid: process.pid, bootId: 'custom-remote', state: 'working' }));
  try {
    const entries = await readRemoteAccess(config.dataRoot), previous = entries.custom;
    entries.custom = { origin, owner: input.bridgePath ? 'summon' : 'external', label: String(input.label || '自定义远程入口').slice(0, 80),
      temporary: input.temporary === true, ...(input.bridgePath ? { bridgePath: input.bridgePath } : {}), ...(input.workId ? { workId: input.workId } : {}) };
    await writeRemoteAccess(config.dataRoot, entries);
    let registered = false;
    try {
      const startedAt = Date.now();
      let deadline = startedAt + 30000;
      let probe;
      do {
        probe = await inspectRemoteOrigin(config, origin, { signal });
        if (probe.reachable) {
          registered = true;
          return { provider: 'custom', state: 'reachable', registered: true, reachable: true, ...entries.custom };
        }
        // A newly issued tunnel hostname can lag behind the live connector.
        // Keep this same route alive while DNS and the edge become available.
        if (['ENOTFOUND', 'EAI_AGAIN'].includes(probe.code) || probe.status >= 520) deadline = startedAt + 90000;
        await pause(500, undefined, { signal });
      } while (Date.now() < deadline);
      return { provider: 'custom', state: 'unreachable', registered: false, reachable: false, origin, error: probe };
    } finally {
      if (!registered) {
        if (previous) entries.custom = previous;
        else delete entries.custom;
        await writeRemoteAccess(config.dataRoot, entries);
      }
    }
  } finally { await lock.close(); }
}

export async function removeCustomRemote(config, workId) {
  const lock = await acquireServiceLock(config.dataRoot, 'remote-access-operation', () => ({ pid: process.pid, bootId: 'custom-remote', state: 'working' }));
  try {
    const entries = await readRemoteAccess(config.dataRoot);
    if (entries.custom?.workId === workId) {
      delete entries.custom;
      await writeRemoteAccess(config.dataRoot, entries);
    }
  } finally { await lock.close(); }
}
