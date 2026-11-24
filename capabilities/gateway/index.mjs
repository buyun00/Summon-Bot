import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { BotRuntime } from '../../bot/src/runtime/bot.mjs';
import { createRedactor } from '../../bot/src/runtime/config.mjs';
import { readUsage, usageRange, finishUsageTotals, emptyUsageTotals, USAGE_PRICING } from '../../bot/src/agent/usage.mjs';
import { assertInstallationWritable, readInstallationState } from '../../scripts/installation/installation-state.mjs';
import { AttachmentStore, MAX_ATTACHMENT_REQUEST_BYTES } from '../chatroom/attachments.mjs';
import { ChatroomService } from '../chatroom/service.mjs';
import { ModelConnections } from '../models/service.mjs';
import { protocolVersion, reject, user } from '../platform/contract.mjs';
import { SummonPlatform } from '../platform/platform.mjs';
import { SummonConnections, connectionRecords } from '../services/connections.mjs';
import { RecordStore } from '../shared/store.mjs';
import { IncrementalSync, syncPages } from '../shared/sync.mjs';
import { PushService } from './push.mjs';
import { createApi } from './api.mjs';

const same = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function requestBody(req, limit) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return {};
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) reject('content_type', 'JSON is required', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) reject('request_too_large', 'Request exceeds the allowed size', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { reject('invalid_json', 'Invalid request JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('invalid_json', 'A JSON object is required');
  return body;
}

function json(res, status, result) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(result));
}

function canOmitVersion(method, path) {
  return method === 'GET' && ['/api/bootstrap', '/api/health'].includes(path) ||
    ['GET', 'HEAD'].includes(method) && (
      /^\/api\/attachments\/[^/]+(?:\/(?:preview|view))?$/.test(path) ||
      /^\/api\/files\/[^/]+\/download$/.test(path) ||
      /^\/api\/workspaces\/[^/]+\/file$/.test(path)
    );
}

function acceptsDuringDrain(path) {
  return ['/api/attachments', '/api/executions/input', '/api/platform/send', '/api/platform/send_input'].includes(path) ||
    /^\/api\/rooms\/[^/]+\/messages$/.test(path);
}

function usageSnapshot(ledger, params, bots, rooms) {
  const range = usageRange(params.get('period') || 'today');
  const botId = params.get('botId') || null;
  const roomId = params.has('roomId') ? params.get('roomId') || null : undefined;
  const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 25);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject('invalid_page', 'Invalid usage page');
  if (roomId && !rooms.some(item => item.id === roomId)) reject('scope_unavailable', 'Usage scope is unavailable', 404);
  return ledger.snapshot(() => {
    const snapshot = readUsage(ledger.db, range, { roomId, botId, offset, limit });
    const botNames = new Map(bots.map(bot => [bot.id, bot.name]));
    const roomNames = new Map(rooms.map(room => [room.id, room.name]));
    const botUsage = snapshot.bots.map(row => ({ ...row, id: row.key, name: botNames.get(row.key) || row.name || row.key,
      kind: 'bot', removed: !botNames.has(row.key) }));
    if (!botId && roomId === undefined) for (const bot of bots) {
      if (!botUsage.some(row => row.id === bot.id)) botUsage.push({ ...finishUsageTotals(emptyUsageTotals()), id: bot.id, name: bot.name, kind: 'bot' });
    }
    const roomUsage = snapshot.rooms.map(row => ({ ...row, id: row.key, name: roomNames.get(row.key) || row.name || '未归属会话', kind: 'room' }));
    const providerReports = ledger.providerReports(range).map(report => {
      const from = new Date(`${report.day}T00:00:00+08:00`).toISOString();
      const local = readUsage(ledger.db, { from, to: new Date(Date.parse(from) + 86400000).toISOString() }, { detail: false }).totals;
      return { ...report, localCalls: local.calls, localTokens: local.totalTokens, localCostMin: local.costMin, localCostMax: local.costMax,
        localPricedCalls: local.pricedCalls, differenceCalls: report.calls - local.calls, differenceTokens: report.totalTokens - local.totalTokens,
        tokenCoverage: report.totalTokens ? local.totalTokens / report.totalTokens : null };
    });
    return { ...snapshot, bots: botUsage, rooms: roomUsage, range, botId, roomId, providerReports, coverage: ledger.coverage(range), pricing: USAGE_PRICING,
      requests: snapshot.requests.map(request => ({ ...request, botName: botNames.get(request.botId) || request.botName || request.botId })) };
  });
}

export async function startGateway(options = {}) {
  if (typeof options.dataRoot !== 'string' || typeof options.releaseRoot !== 'string') throw new Error('dataRoot and releaseRoot are required');
  const dataRoot = resolve(options.dataRoot), releaseRoot = resolve(options.releaseRoot), host = options.host || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Summon platform uses a loopback gateway');
  await assertInstallationWritable(dataRoot, releaseRoot);

  const token = options.token || randomBytes(32).toString('base64url');
  const release = await readOptional(join(releaseRoot, 'release.json'));
  const history = await readOptional(join(dataRoot, 'history.json'));
  if (history?.status && history.status !== 'complete') throw new Error('Offline history maintenance is incomplete');
  const historyEpoch = history?.historyEpoch ?? null;
  const clients = new Set(), requests = new Set(), stores = [];
  let platform, runtime, models, connections, push, server, url, timer, heartbeatTimer, usageTimer, activeTick, activeConnectionTick, closeTask, installation;
  let closing = false;
  let drainSnapshot;
  function store(name) {
    const result = new RecordStore(join(dataRoot, 'capabilities', name, 'state.sqlite'));
    stores.push(result);
    return result;
  }
  function emit(type, payload = null) {
    if (type === 'models.changed' && payload?.id) {
      runtime?.resumeRecoveredRuns?.({ kind: 'model', id: payload.id });
    }
    const line = `data: ${JSON.stringify({ type })}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 65536) client.destroy();
      else client.write(line);
    }
  }
  function applyWindow(state) {
    if (!state || !['prepared', 'draining'].includes(state.phase)) return;
    installation = state;
    if (!platform.draining) {
      platform.draining = true;
      runtime.setDraining(true);
    }
  }
  async function installationDrain(state) {
    installation = state;
    if (state?.intake_closed) await Promise.all([models.pauseUsage(), push?.close()]);
    const observation = await platform.installDrain(state);
    const active = [...observation.active];
    if (activeTick) active.push({ kind: 'gateway', id: 'collector', status: 'writing' });
    if (requests.size) active.push({ kind: 'gateway', id: 'http', status: 'writing' });
    if (state?.phase === 'draining' && drainSnapshot?.migration_id !== state.migration_id) {
      drainSnapshot = { migration_id: state.migration_id, active: observation.active.map(({ kind, id }) => ({ kind, id })) };
    }
    return { active, started_calls: drainSnapshot?.active ?? [], intake_closed: state?.intake_closed === true, ready: active.length === 0 };
  }
  async function tick() {
    const state = await readInstallationState(dataRoot);
    if (closing) return;
    applyWindow(state);
    if (state && ['converting', 'data_ready'].includes(state.phase)) return;
    if (!platform.draining && !activeConnectionTick) {
      activeConnectionTick = Promise.resolve().then(() => connections.tick())
        .catch(error => console.error(`Summon external Session observation failed (${error.code || error.name})`))
        .finally(() => { activeConnectionTick = null; });
    }
    await platform.tick({ observations: !platform.draining, deliveries: !installation?.intake_closed });
  }
  function queueTick() {
    if (closing || activeTick) return;
    activeTick = tick().catch(error => console.error(`Summon platform maintenance failed (${error.code || error.name})`)).finally(() => { activeTick = null; });
  }
  function close() {
    return closeTask ??= (async () => {
      closing = true;
      clearInterval(timer);
      clearInterval(heartbeatTimer);
      clearInterval(usageTimer);
      for (const client of clients) client.end();
      const closed = server?.listening ? new Promise(done => server.close(done)) : null;
      server?.closeIdleConnections();
      await Promise.allSettled([...requests, activeTick, activeConnectionTick]);
      await Promise.allSettled([runtime?.close(), connections?.close(), models?.close(), push?.close()]);
      await Promise.allSettled([...(platform?.botStops || [])]);
      await closed;
      for (const value of stores) value.close();
    })();
  }

  try {
    const records = store('chatroom');
    const sync = new IncrementalSync(store('gateway'));
    const attachments = new AttachmentStore(join(dataRoot, 'capabilities', 'chatroom'));
    models = await new ModelConnections({ dataRoot, model: options.model, emit }).initialize();
    const model = { connectionStore: models.path };
    const clean = createRedactor({ model });
    platform = new SummonPlatform({ store: records, dataRoot, releaseRoot, models, attachments, emit,
      workspaces: options.workspaces });
    const room = new ChatroomService({ store: records, manager: platform.manager, attachments, platform, emit });
    connections = new SummonConnections({ store: records, dataRoot, workspace: options.defaultCwd || releaseRoot,
      assertSessionAuthority: (session, options) => platform.assertSessionAuthority(session, options),
      onWorkEvent: (sessionId, callId, position, facts) => platform.roomWork.publish(sessionId, callId, position, facts),
      onProgressChange: () => emit('execution'),
      onEvent: (sessionId, callId, facts) => { const event = platform.recordReceipt(callId, facts, sessionId); emit('execution'); return event; } });
    models.attachConnections(() => connections.store.list(connectionRecords));
    runtime = new BotRuntime({ dataRoot, releaseRoot, model, platform, emit });
    platform.attach({ room, runtime, connections });
    platform.initializeDefaults();
    platform.resources.recoverModels();
    platform.recoverCalls();
    await runtime.initialize();
    push = await new PushService({ openStore: () => store('push'), messages: records, dataRoot, historyEpoch }).initialize();
    const api = createApi({ platform, room, attachments, models, connections, push, sync, historyEpoch, emit,
      getUsage: (params, context) => {
        if (!runtime.usage || runtime.usageRecoveryFailed) reject('usage_unavailable', 'The local usage report is unavailable', 503);
        const bots = platform.listBots().filter(bot => platform.visibleBot(bot, context));
        const rooms = room.rooms(user.id);
        try {
          const report = usageSnapshot(runtime.usage, params, bots, rooms);
          if (runtime.usageIncomplete) report.coverage.writeFailures = true;
          return report;
        }
        catch (error) {
          if (error.status) throw error;
          reject('usage_unavailable', 'The local usage report is unavailable', 503);
        }
      } });

    server = createServer((req, res) => {
      const task = (async () => {
        try {
          const request = new URL(req.url, 'http://localhost');
          const path = request.pathname, params = request.searchParams;
          const authorization = req.headers.authorization;
          if (!same(authorization, `Bearer ${token}`)) reject('unauthorized', 'Authorization required', 401);
          const currentInstall = await readInstallationState(dataRoot);
          applyWindow(currentInstall);
          if (path === '/api/bootstrap' && req.method === 'GET') {
            const updating = platform.draining || closing || ['converting', 'data_ready'].includes(currentInstall?.phase);
            return json(res, 200, { protocolVersion, updating, version: release?.version ?? options.version ?? null, releasesUrl: '/api/releases' });
          }
          if (closing) reject('updating', 'Summon Bot is stopping', 503);
          if (!path.startsWith('/api/')) reject('not_found', 'Route not found', 404);
          const version = req.headers['x-summon-protocol'] ?? (path === '/api/stream' ? params.get('protocol') : null);
          if (!canOmitVersion(req.method, path) && version !== String(protocolVersion)) {
            reject('protocol_mismatch', 'Client and server use different protocol versions', 426, { protocolVersion, releasesUrl: '/api/releases' });
          }
          if (req.method === 'GET' && path === '/api/stream') {
            if (installation?.intake_closed) reject('updating', 'Summon Bot is being updated', 503);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write('data: {"type":"connected"}\n\n');
            clients.add(res);
            res.on('close', () => clients.delete(res));
            return;
          }
          if (installation?.intake_closed || currentInstall && ['converting', 'data_ready'].includes(currentInstall.phase)) {
            reject('updating', 'Summon Bot is being updated', 503);
          }
          if (platform.draining && !['GET', 'HEAD'].includes(req.method) && !acceptsDuringDrain(path)) {
            reject('updating', 'Summon Bot is being updated', 503);
          }
          const limit = path === '/api/attachments' ? MAX_ATTACHMENT_REQUEST_BYTES : 4 * 1024 * 1024;
          const body = await requestBody(req, limit);
          if (!['GET', 'HEAD'].includes(req.method)) {
            const latestInstall = await readInstallationState(dataRoot);
            applyWindow(latestInstall);
            if (installation?.intake_closed || ['converting', 'data_ready'].includes(latestInstall?.phase)) {
              reject('updating', 'Summon Bot is being updated', 503);
            }
            if (platform.draining && !acceptsDuringDrain(path)) {
              reject('updating', 'Summon Bot is being updated', 503);
            }
          }
          const result = await api(req.method, path, params, body, req.headers['x-summon-client-id']);
          if (result === undefined) reject('not_found', 'Route not found', 404);
          if (Buffer.isBuffer(result.bytes)) {
            res.writeHead(200, result.headers);
            res.end(req.method === 'HEAD' ? undefined : result.bytes);
          } else if (result.stream) {
            res.writeHead(200, result.headers);
            if (req.method === 'HEAD') {
              result.stream.destroy();
              res.end();
            } else {
              await pipeline(result.stream, res);
            }
          } else if (result.sync && params.get('pages') === '1') {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform' });
            await pipeline(Readable.from(syncPages(result)), res);
          } else json(res, 200, result);
        } catch (error) {
          if (res.headersSent) { res.end(); return; }
          const status = error.status || 500;
          const diagnostic = clean.error({ message: error.message, status: error.status, code: error.code,
            details: error.details ?? (error.revision === undefined ? undefined : { revision: error.revision }) });
          const details = diagnostic.details ?? (error.code === 'protocol_mismatch' ? { protocolVersion, releasesUrl: '/api/releases' } : undefined);
          if (status >= 500 && !error.status) console.error('Summon platform request failed', diagnostic.message);
          json(res, status, { error: diagnostic.message || 'The Summon host could not complete this request',
            code: diagnostic.code || error.code || 'request_failed', details, ...(error.code === 'protocol_mismatch' ? details : {}), call_id: error.call_id });
        }
      })();
      requests.add(task);
      void task.catch(() => res.destroy()).finally(() => requests.delete(task));
    });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(options.port || 0, host, done); });
    const port = server.address().port;
    url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
    await options.onListening?.({ url, port });
    await mkdir(join(dataRoot, 'capabilities', 'gateway'), { recursive: true });
    await writeFile(join(dataRoot, 'capabilities', 'gateway', 'run.json'), JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }));
    timer = setInterval(queueTick, 500);
    timer.unref();
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.writableLength > 65536) client.destroy();
        else client.write(': ping\n\n');
      }
    }, 20_000);
    heartbeatTimer.unref();
    const warmUsage = () => { if (!closing && !platform.draining) void models.refreshUsage(false).catch(() => {}); };
    usageTimer = setInterval(warmUsage, 120_000);
    usageTimer.unref();
    warmUsage();
    queueTick();
    return { url, token, platform, close, installationDrain };
  } catch (error) {
    await close();
    throw error;
  }
}
