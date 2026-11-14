import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AttachmentStore, MAX_ATTACHMENT_REQUEST_BYTES } from '../../../capabilities/chatroom/attachments.mjs';
import { RecordStore } from '../../../capabilities/shared/store.mjs';
import { IncrementalSync, syncPages } from '../../../capabilities/shared/sync.mjs';

const read = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
const failure = (status, message, code) => Object.assign(new Error(message), { status, code });
const updating = () => failure(503, 'Summon Bot 正在更新。请保留原消息和发送标识，稍后重试。', 'updating');
const changes = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase();

async function body(request, limit) {
  const chunks = [];
  let size = 0;
  const stream = request.iterator({ destroyOnReturn: false });
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw failure(413, '请求过大。');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, '请求应为 JSON 对象。');
  return value;
}

export async function startGateway({ dataRoot, releaseRoot, token, host = '127.0.0.1', port = 0, onListening }) {
  if (!['127.0.0.1', '::1'].includes(host) || typeof token !== 'string' || !token) throw new Error('Invalid legacy handoff gateway configuration');
  const expected = Buffer.from(`Bearer ${token}`);
  const statePath = join(dataRoot, 'config', 'installation_state.json');
  const bootstrapPath = join(dataRoot, 'config', 'first_cutover_104.json');
  const bootstrap = await read(bootstrapPath);
  if (!same(bootstrap?.handoff_release, releaseRoot) || !['writers_stopped', 'handoff_selected'].includes(bootstrap?.phase) ||
      !Array.isArray(bootstrap.started_calls)) throw new Error('Legacy handoff does not own the stopped deployment');
  const historyEpoch = (await read(join(dataRoot, 'history.json')))?.historyEpoch ?? null;
  const rooms = new RecordStore(join(dataRoot, 'capabilities', 'chatroom', 'state.sqlite'));
  const management = new RecordStore(join(dataRoot, 'capabilities', 'bot-management', 'state.sqlite'));
  const gateway = new RecordStore(join(dataRoot, 'capabilities', 'gateway', 'state.sqlite'));
  const attachments = new AttachmentStore(join(dataRoot, 'capabilities', 'chatroom'));
  const sync = new IncrementalSync(gateway);
  const clients = new Set(), requests = new Set(), writes = new Set();
  let closed = false, intakeClosed = false;
  const notify = () => { for (const client of clients) client.write('data: {"type":"message"}\n\n'); };
  const roomMessages = id => rooms.db.prepare(
    "SELECT data FROM records WHERE kind='messages' AND json_extract(data,'$.roomId')=? ORDER BY created_at,rowid"
  ).all(id).map(({ data }) => JSON.parse(data));
  const publicBot = ({ id, name, status, runIntent, avatar, workspaceProfileId, presetId }) => ({
    id, name, status, runIntent, avatar, workspaceProfileId, presetId,
  });
  const jobs = id => rooms.list('deliveries').filter(job => !id || job.roomId === id).map(
    ({ id, roomId, messageId, botId, taskId, status, label }) => ({ id, roomId, messageId, botId, taskId, status, label })
  );

  function getRoom(id, profileId) {
    const room = rooms.get('rooms', id);
    if (!room?.members?.includes('user') || (room.workspaceProfileId || null) !== profileId) throw failure(404, '会话不可用。');
    return room;
  }

  function saveMessage(room, input, migrationId) {
    const id = input.clientId || input.id;
    if (typeof id !== 'string' || !id || id.length > 512) throw failure(400, '请保留原发送标识。');
    const previous = roomMessages(room.id).find(item => item.senderId === 'user' && (item.clientId === id || item.id === id));
    if (previous) return previous;
    if (room.status === 'concluded') throw failure(409, '会话已结束。');
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    const files = attachments.resolve(input.attachments);
    const profile = room.workspaceProfileId || null;
    for (const file of files) {
      const pending = rooms.get('installation-attachments', file.id);
      const origin = file.origin?.roomId && rooms.get('rooms', file.origin.roomId);
      if ((pending && pending.workspace !== profile) || (origin && (origin.workspaceProfileId || null) !== profile)) {
        throw failure(403, '附件不属于此工作区。');
      }
    }
    if ((!content && !files.length) || content.length > 16000) throw failure(400, '消息为空或超过长度限制。');
    const parent = input.replyTo && rooms.get('messages', input.replyTo);
    if (input.replyTo && parent?.roomId !== room.id) throw failure(400, '回复目标不在同一会话。');
    if (input.toBotId && !room.members.includes(input.toBotId)) throw failure(400, '目标不在此会话。');
    const messageId = randomUUID();
    const saved = rooms.transaction(() => rooms.save('messages', { id: messageId, clientId: id, roomId: room.id, senderId: 'user',
      ...(parent && { replyTo: parent.id }), ...(input.toBotId && { toBotId: input.toBotId }),
      rootId: parent?.rootId || messageId, hop: parent ? (Number(parent.hop) || 0) + 1 : 0,
      kind: 'message', content, attachments: files, installation_migration_id: migrationId }));
    notify();
    return saved;
  }

  function snapshot(response, url, scope, value) {
    if (url.searchParams.get('sync') !== '1') return json(response, 200, value);
    const projected = { ...sync.respond(scope, value, url.searchParams.get('since')), historyEpoch };
    if (url.searchParams.get('pages') !== '1') return json(response, 200, projected);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    return pipeline(Readable.from(syncPages(projected)), response);
  }

  async function route(request, response) {
    const actual = Buffer.from(request.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw failure(401, 'Unauthorized');
    if (closed) throw updating();
    const url = new URL(request.url, 'http://localhost'), method = request.method;
    const profileId = url.searchParams.get('workspace') || null;
    if (profileId && !gateway.get('workspace-profiles', profileId)) throw failure(404, '工作区不可用。');
    const messages = /^\/api\/rooms\/([^/]+)\/messages$/.exec(url.pathname);
    if (changes.has(method)) {
      const state = await read(statePath);
      const installation = state?.phase === 'draining' && same(state.previous_release, releaseRoot) ? state : null;
      if (intakeClosed || state && !['prepared', 'draining'].includes(state.phase) ||
          installation?.intake_closed || method !== 'POST' ||
          (!messages && url.pathname !== '/api/attachments')) throw updating();
      const value = await body(request, messages ? 2 * 1024 * 1024 : MAX_ATTACHMENT_REQUEST_BYTES);
      const current = await read(statePath);
      if (closed || intakeClosed || current?.intake_closed ||
          current && (!['prepared', 'draining'].includes(current.phase) || !same(current.previous_release, releaseRoot))) throw updating();
      if (!messages) {
        const file = await attachments.upload(value);
        rooms.save('installation-attachments', { id: file.id, workspace: profileId });
        return json(response, 200, file);
      }
      const room = getRoom(decodeURIComponent(messages[1]), profileId);
      const replied = value.replyTo && rooms.get('messages', value.replyTo);
      const nativeQuestion = value.replyTo && gateway.get('native-room-requests', value.replyTo);
      if (nativeQuestion?.roomId === room.id || replied?.eventType === 'work_file_access_requested') throw updating();
      return json(response, 200, saveMessage(room, value, current?.migration_id || installation?.migration_id || bootstrap.id));
    }
    if (method !== 'GET' && method !== 'HEAD') throw failure(405, 'Unsupported method');
    if (url.pathname === '/api/health') return json(response, 200, { ok: true, service: 'summon-capabilities', updating: true });
    if (url.pathname === '/api/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.write('data: {"type":"connected"}\n\n');
      clients.add(response); response.once('close', () => clients.delete(response));
      return;
    }
    if (messages) {
      const id = decodeURIComponent(messages[1]);
      return snapshot(response, url, `room:${id}`, { historyEpoch, room: getRoom(id, profileId), messages: roomMessages(id), jobs: jobs(id) });
    }
    const file = /^\/api\/attachments\/([^/]+)(?:\/(preview|view))?$/.exec(url.pathname);
    if (file) {
      const id = decodeURIComponent(file[1]);
      // Existing image/link URLs omit the workspace query. They retain the
      // installed web service's session and the controller's attachment ACL.
      const field = rooms.get('installation-attachments', id);
      const origin = attachments.get(id).origin?.roomId;
      if (profileId && ((field && field.workspace !== profileId) ||
          (origin && (rooms.get('rooms', origin)?.workspaceProfileId || null) !== profileId))) {
        throw failure(404, '附件不可用。');
      }
      const { headers, bytes } = await attachments.read(id, file[2] === 'view' ? 'view' : file[2] === 'preview');
      response.writeHead(200, headers); response.end(method === 'HEAD' ? undefined : bytes);
      return;
    }
    const accessibleRooms = rooms.list('rooms').filter(room => room.members?.includes('user') && (room.workspaceProfileId || null) === profileId);
    if (url.pathname === '/api/rooms') return json(response, 200, { rooms: accessibleRooms });
    if (url.pathname === '/api/state') {
      return snapshot(response, url, profileId ? `workspace:${profileId}` : 'workspace', {
        historyEpoch, workspaceProfileId: profileId, updating: true, provider: { configured: true },
        bots: management.list('bots').filter(bot => !bot.archivedAt && (bot.workspaceProfileId || null) === profileId).map(publicBot),
        rooms: accessibleRooms, activity: [], works: [], agentRuns: [], routines: [], knowledge: { nodes: [], edges: [] },
        runtime: { started: true, fast: { running: 0, queued: 0 }, deep: { running: 0, queued: 0 }, jobs: [] },
      });
    }
    throw updating();
  }

  const server = createServer((request, response) => {
    const work = route(request, response).catch(error => {
      if (!response.headersSent) json(response, error.status || (error instanceof SyntaxError ? 400 : 500),
        { error: error.status ? error.message : 'Summon Bot 正在更新。', ...(error.code && { code: error.code }) });
      else response.destroy();
    });
    const write = changes.has(request.method);
    requests.add(work);
    if (write) writes.add(work);
    void work.finally(() => { requests.delete(work); writes.delete(work); }).catch(() => {});
  });
  server.requestTimeout = 30000;
  try {
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, host, ready); });
    await onListening?.({ port: server.address().port });
  } catch (error) {
    server.close();
    gateway.close(); management.close(); rooms.close();
    throw error;
  }
  let closing;
  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`,
    async installationDrain(state) {
      if (state.intake_closed) intakeClosed = true;
      const active = writes.size ? [{ kind: 'legacy-intake', id: state.migration_id, status: 'saving' }] : [];
      return { active, ready: !active.length, intake_closed: intakeClosed, started_calls: bootstrap.started_calls };
    },
    close() {
      return closing ??= (async () => {
        closed = true; intakeClosed = true;
        for (const client of clients) client.end();
        const stopped = new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()));
        server.closeIdleConnections?.();
        await Promise.allSettled([...requests]);
        await stopped;
        gateway.close(); management.close(); rooms.close();
      })();
    },
  };
}
