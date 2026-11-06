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

export async function probeRemoteOrigin(config, origin) {
  const challenge = randomBytes(32).toString('base64url'), url = new URL('/auth/instance', origin);
  url.searchParams.set('challenge', challenge);
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    return response.ok && (await response.json()).proof === workspaceProof(config.web.accessToken, challenge);
  } catch { return false; }
}

export async function registerCustomRemote(config, input) {
  const origin = workspaceOrigin(input.origin, { httpsOnly: true });
  const lock = await acquireServiceLock(config.dataRoot, 'remote-access-operation', () => ({ pid: process.pid, bootId: 'custom-remote', state: 'working' }));
  try {
    const entries = await readRemoteAccess(config.dataRoot), previous = entries.custom;
    entries.custom = { origin, owner: input.bridgePath ? 'summon' : 'external', label: String(input.label || '自定义远程入口').slice(0, 80),
      temporary: input.temporary === true, ...(input.bridgePath ? { bridgePath: input.bridgePath } : {}) };
    await writeRemoteAccess(config.dataRoot, entries);
    const deadline = Date.now() + 30000;
    do {
      if (await probeRemoteOrigin(config, origin)) return { provider: 'custom', state: 'reachable', registered: true, reachable: true, ...entries.custom };
      await pause(500);
    } while (Date.now() < deadline);
    if (previous) entries.custom = previous;
    else delete entries.custom;
    await writeRemoteAccess(config.dataRoot, entries);
    return { provider: 'custom', state: 'unreachable', registered: false, reachable: false, origin };
  } finally { await lock.close(); }
}
