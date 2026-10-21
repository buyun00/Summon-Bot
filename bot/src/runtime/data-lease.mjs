import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { acquireIdentityLock } from './identity-lock.mjs';

/** External maintenance uses the same OS-held exclusion as the Bot writer. */
export async function withBotDataLease(dataDir, operation, { botId = basename(dataDir), purpose = 'maintenance' } = {}) {
  const leaseId = randomUUID();
  const lock = await acquireIdentityLock(dataDir, () => ({ botId, instanceId: botId, pid: process.pid,
    bootId: leaseId, state: 'maintenance', purpose }));
  try { return await operation(); } finally { await lock.close(); }
}
