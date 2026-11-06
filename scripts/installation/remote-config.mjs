import { join } from 'node:path';
import { readJson, writeJson } from '../build/files.mjs';
import { workspaceOrigin } from '../../web/backend/origins.mjs';

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
  const { cloudflare, tailscale } = await readRemoteAccess(dataRoot);
  return [cloudflare, tailscale].filter(entry => entry?.origin && !entry.pending)
    .map(entry => workspaceOrigin(entry.origin, { httpsOnly: true }));
}
