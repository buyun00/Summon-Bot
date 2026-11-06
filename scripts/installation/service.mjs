import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, readJson, writeJson } from '../build/files.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { installProcessLog } from '@summon/bot/process-log';
import { remoteOrigins } from './remote-config.mjs';
import { serviceFolders, serviceRoot as rootForService, serviceRunPath } from './system.mjs';

const bootId = randomUUID();
const notify = value => { if (process.connected) process.send(value, () => {}); };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
let app, record, ownership, processLog, control, runPath, closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app?.close();
  await writeJson(runPath, { ...record, state: 'stopped', stoppedAt: new Date().toISOString() });
  await new Promise(resolveClose => { control.close(resolveClose); control.closeAllConnections?.(); });
  try { processLog?.close(); } finally { await ownership.close(); }
}
try {
  const { options } = parseArgs(process.argv.slice(2));
  const config = await readJson(resolve(options.config));
  const type = options.type;
  if (!Object.hasOwn(serviceFolders, type)) throw new Error('Unknown managed service type');
  const serviceRoot = rootForService(config.dataRoot, type);
  runPath = serviceRunPath(config.dataRoot, type);
  ownership = await acquireServiceLock(config.dataRoot, type, () => record || { pid: process.pid, bootId, state: 'starting', releaseRoot: config.releaseRoot });
  processLog = installProcessLog(join(serviceRoot, 'logs'), { ...config.logs, ...config[type]?.logs });
  // Node's fatal stderr path can bypass the redirected stream on Windows.
  // Observe without swallowing the exception or leaving a broken service alive.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    try { console.error(JSON.stringify({type:'service.fatal',origin,message:error.message,stack:error.stack})); } catch {}
  });
  const authorized = value => { const expected = Buffer.from(`Bearer ${config.controlToken}`), actual = Buffer.from(value || ''); return actual.length === expected.length && timingSafeEqual(actual, expected); };
  control = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization)) return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ...record, state: closing ? 'stopping' : 'ready' });
    if (req.method === 'POST' && req.url === '/shutdown') {
      json(res, 202, { accepted: true, bootId });
      setImmediate(() => shutdown().catch(error => { console.error(error.message); process.exitCode = 1; }));
      return;
    }
    json(res, 404, { error: 'Not found' });
  });
  process.once('SIGINT', () => shutdown().catch(() => { process.exitCode = 1; }));
  process.once('SIGTERM', () => shutdown().catch(() => { process.exitCode = 1; }));
  if (type === 'gateway') {
    const { startGateway } = await import(pathToFileURL(join(config.releaseRoot, 'capabilities/gateway/index.mjs')));
    app = await startGateway({ dataRoot: config.dataRoot, releaseRoot: config.releaseRoot, defaultCwd: config.defaultCwd,
      ...config.gateway, token: config.gatewayToken, model: config.model, codexPath: config.codexPath,
      onListening: async ({port}) => {
        if (!config.gateway.port) {
          const latest = await readJson(resolve(options.config));
          await writeJson(resolve(options.config), { ...latest, gateway: { ...latest.gateway, port } });
          config.gateway.port = port;
        }
      } });
    if (!config.gateway.port) {
      const latest = await readJson(resolve(options.config));
      await writeJson(resolve(options.config), { ...latest, gateway: { ...latest.gateway, port: Number(new URL(app.url).port) } });
    }
  } else if (type === 'web') {
    const { startWeb } = await import(pathToFileURL(join(config.releaseRoot, 'web/backend/server.mjs')));
    const gateway = await readJson(join(config.dataRoot, 'capabilities/gateway/run/current.json'));
    app = await startWeb({ ...config.web, getRemoteOrigins: () => remoteOrigins(config.dataRoot),
      clientReleaseRoot: join(config.dataRoot, 'client-releases'),
      webRelease: await readJson(join(config.releaseRoot, 'release.json')),
      frontendRoot: join(config.releaseRoot, 'web/frontend'), gatewayUrl: gateway.url, gatewayToken: config.gatewayToken });
  } else {
    const { startAuxiliary } = await import('./auxiliaries.mjs');
    app = await startAuxiliary(config, type, () => void shutdown().catch(() => { process.exitCode = 1; }));
  }
  await new Promise((ready, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', ready); });
  record = { type, pid: process.pid, bootId, url: app.url, state: 'ready', releaseRoot: config.releaseRoot,
    controlUrl: `http://127.0.0.1:${control.address().port}`, startedAt: new Date().toISOString() };
  await writeJson(runPath, record);
  console.log(JSON.stringify({ type: `${type}.ready`, pid: process.pid, bootId, url: app.url }));
  notify({ ...record, type: 'ready' });
} catch (error) {
  notify({ type: 'error', code: error.code, message: error.message });
  await app?.close().catch(() => {});
  control?.close();
  try { console.error(error.stack || error.message); }
  finally { try { processLog?.close(); } finally { await ownership?.close(); } }
  process.exitCode = 1;
}
