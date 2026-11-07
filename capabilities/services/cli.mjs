import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireIdentityLock } from '../../bot/src/runtime/identity-lock.mjs';
import { installProcessLog } from '../../bot/src/runtime/process-log.mjs';
import { startCapabilityService, validateServiceIdentity } from './host.mjs';
import { writePrivateJson } from './supervisor.mjs';
import { verifyCapabilityPackage } from './publish.mjs';
import { verifyRelease } from '../../scripts/build/verify.mjs';

const notify = value => { if (process.connected) process.send(value, () => {}); };
const bootId = randomUUID();
let ownership, processLog, service, descriptor, record, config, finishing;
async function finished() {
  if (finishing) return finishing;
  finishing = (async () => {
    try {
      if (config && ownership) await writePrivateJson(join(config.serviceRoot, 'run/current.json'), { ...record, state: 'stopped', stoppedAt: new Date().toISOString() });
    } finally {
      try { processLog?.close(); } finally { await ownership?.close(); }
      if (process.connected) process.disconnect();
    }
  })();
  return finishing;
}
try {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: capability-service --config <private-config.json>');
  config = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8'));
  validateServiceIdentity(config.id, config.version);
  await mkdir(join(config.serviceRoot, 'run'), { recursive: true });
  record = { serviceId: config.id, version: config.version, stateVersion: config.stateVersion, pid: process.pid, bootId, state: 'starting', startedAt: new Date().toISOString() };
  ownership = await acquireIdentityLock(join(config.serviceRoot, 'run'), () => record);
  processLog = installProcessLog(join(config.serviceRoot, 'logs'), config.options?.logs, { tee: false });
  if (config.options?.packageRoot || config.options?.contentHash) {
    const checked = config.options.packageRoot ? await verifyCapabilityPackage(config.options.packageRoot) : await verifyRelease(config.options.releaseRoot || config.releaseRoot);
    if (checked.contentHash !== config.options.contentHash) throw Object.assign(new Error('Capability package integrity no longer matches its deployed version'), { code: 'SERVICE_PACKAGE_DIGEST_MISMATCH' });
  }
  const factory = await import(pathToFileURL(config.module));
  if (typeof factory.createCapability !== 'function') throw new Error('Capability module must export createCapability(options)');
  descriptor = await factory.createCapability({ ...config.options, id: config.id, version: config.version, stateVersion: config.stateVersion,
    dataRoot: config.dataRoot, releaseRoot: config.releaseRoot, serviceRoot: config.serviceRoot, serviceToken: config.token });
  if (!descriptor || typeof descriptor !== 'object') throw new Error('Capability factory returned no descriptor');
  service = await startCapabilityService({ ...descriptor, id: config.id, version: config.version, stateVersion: config.stateVersion, token: config.token,
    onClosed: async () => { try { await descriptor.onClosed?.(); } finally { await finished(); } }, onError: error => { console.error(error.message); process.exitCode = 1; } });
  record = { ...record, state: 'ready', url: service.url };
  await writePrivateJson(join(config.serviceRoot, 'run/current.json'), record);
  process.on('SIGINT', () => { service.close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  process.on('SIGTERM', () => { service.close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  notify({ type: 'ready', ...record });
  console.log(JSON.stringify({ type: 'capability.ready', id: config.id, version: config.version, pid: process.pid, bootId }));
} catch (error) {
  notify({ type: 'error', code: error.code, message: error.message });
  if (processLog) console.error(error.message);
  try { if (service) await service.close(); else await descriptor?.close?.(); } finally { await finished(); }
  process.exitCode = 1;
}
