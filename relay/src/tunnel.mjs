import { WebSocket } from 'ws';

const CHUNK_REQ = 1;
const CHUNK_RES = 2;
const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 512 * 1024;
const LARGE_THRESHOLD = 1024 * 1024;

const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization',
]);

function encodeBinaryChunk(kind, streamId, payload) {
  const buf = Buffer.allocUnsafe(5 + payload.length);
  buf[0] = kind;
  buf.writeUInt32BE(streamId, 1);
  payload.copy(buf, 5);
  return buf;
}

class NodeTunnel {
  constructor({ ws, node, onEvent, onPush, onClose, maxUploadMb }) {
    this.ws = ws;
    this.node = { ...node };
    this.onEvent = onEvent;
    this.onPush = onPush;
    this.onClose = onClose;
    this.maxUploadMb = maxUploadMb;
    this.connectedAt = new Date().toISOString();
    this.protocolVersion = 3;
    this.nodeVersion = null;
    this.nextStreamId = 1;
    this.streams = new Map();
    this.highQueue = [];
    this.lowQueue = [];
    this.draining = false;
    this.alive = true;
    this.closed = false;

    ws.on('pong', () => { this.alive = true; });
    ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    ws.on('close', () => this.cleanup());
    ws.on('error', () => this.cleanup());

    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      if (!this.alive) {
        this.ws.terminate();
        return;
      }
      this.alive = false;
      try { this.ws.ping(); } catch {}
    }, 20_000);
    this.heartbeat.unref();

    this.enqueueHigh(JSON.stringify({
      type: 'hello.ack',
      nodeId: this.node.id,
      nodeName: this.node.name,
      maxUploadMb: this.maxUploadMb,
    }));
  }

  enqueueHigh(frame) {
    if (this.closed) return;
    this.highQueue.push(frame);
    this.pump();
  }

  enqueueLow(frame) {
    if (this.closed) return;
    this.lowQueue.push(frame);
    this.pump();
  }

  pump() {
    if (this.draining || this.closed) return;
    this.draining = true;
    const step = () => {
      while (!this.closed && this.ws.readyState === WebSocket.OPEN) {
        if (this.ws.bufferedAmount > HIGH_WATER_MARK) {
          setTimeout(step, 15);
          return;
        }
        const next = this.highQueue.length ? this.highQueue.shift() : this.lowQueue.shift();
        if (next === undefined) break;
        try { this.ws.send(next); } catch { this.cleanup(); return; }
      }
      this.draining = false;
    };
    step();
  }

  handleMessage(data, isBinary) {
    this.alive = true;
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 5) return;
      const kind = buf[0];
      const streamId = buf.readUInt32BE(1);
      if (kind !== CHUNK_RES) return;
      const entry = this.streams.get(streamId);
      if (!entry || entry.done) return;
      const chunk = buf.subarray(5);
      entry.resBytes += chunk.length;
      if (!entry.res.destroyed && !entry.res.writableEnded) {
        entry.res.write(chunk);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      if (typeof msg.protocolVersion === 'number') this.protocolVersion = msg.protocolVersion;
      if (typeof msg.version === 'string') this.nodeVersion = msg.version;
      if (typeof msg.platform === 'string') this.node.platform = msg.platform;
      if (typeof msg.hostname === 'string') this.node.hostname = msg.hostname;
      this.onEvent?.('hello', this.node);
      return;
    }

    if (msg.type === 'node.event') {
      this.onEvent?.('event', msg.event);
      return;
    }

    if (msg.type === 'push.notify') {
      this.onPush?.({
        userId: this.node.userId,
        nodeId: this.node.id,
        nodeName: this.node.name,
        roomId: msg.roomId,
        messageId: msg.messageId,
        notificationId: msg.notificationId,
        createdAt: msg.createdAt,
      });
      return;
    }

    const entry = this.streams.get(msg.streamId);
    if (!entry || entry.done) return;

    if (msg.type === 'http.res.start') {
      const headers = {};
      for (const [k, v] of Object.entries(msg.headers || {})) {
        const lower = k.toLowerCase();
        if (hopHeaders.has(lower) || lower === 'set-cookie') continue;
        headers[k] = v;
      }
      headers['Cache-Control'] = 'private, no-store, no-transform';
      headers['X-Content-Type-Options'] = 'nosniff';
      if (!entry.res.headersSent) {
        entry.res.writeHead(Number(msg.status) || 502, headers);
      }
      if (!msg.hasBody) this.finishStream(msg.streamId);
      return;
    }

    if (msg.type === 'http.res.end') {
      this.finishStream(msg.streamId);
      return;
    }

    if (msg.type === 'http.res.error') {
      this.failStream(msg.streamId, Number(msg.status) || 502, msg.error || '节点请求失败', msg.code || 'node_error');
    }
  }

  proxyHttp(req, res, apiPath, { maxBodyBytes, isLarge, releaseLargeSlot, timeoutMs = 120_000 }) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      releaseLargeSlot?.();
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '节点当前离线', code: 'node_offline' }));
      return;
    }

    const streamId = this.nextStreamId++;
    if (this.nextStreamId > 0x7fffffff) this.nextStreamId = 1;

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (hopHeaders.has(lower) || v === undefined) continue;
      if (['accept', 'content-type', 'content-length', 'x-summon-protocol', 'x-summon-client-id', 'last-event-id'].includes(lower)) {
        forwardHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
    }

    const entry = {
      res,
      done: false,
      resBytes: 0,
      releaseLargeSlot,
      timer: setTimeout(() => {
        this.enqueueHigh(JSON.stringify({ type: 'http.req.abort', streamId }));
        this.failStream(streamId, 504, '节点响应超时', 'node_timeout');
      }, timeoutMs),
    };
    entry.timer.unref();
    this.streams.set(streamId, entry);

    const onClientClose = () => {
      if (!entry.done) {
        this.enqueueHigh(JSON.stringify({ type: 'http.req.abort', streamId }));
        this.finishStream(streamId, true);
      }
    };
    res.once('close', onClientClose);

    this.enqueueHigh(JSON.stringify({
      type: 'http.req.start',
      streamId,
      method: req.method,
      path: apiPath,
      headers: forwardHeaders,
      hasBody,
    }));

    if (!hasBody) return;

    let received = 0;
    const sendChunk = isLarge ? frame => this.enqueueLow(frame) : frame => this.enqueueHigh(frame);

    req.on('data', chunk => {
      if (entry.done) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        this.enqueueHigh(JSON.stringify({ type: 'http.req.abort', streamId }));
        this.failStream(streamId, 413, `附件或请求体超过中枢上限（${this.maxUploadMb} MB）`, 'request_too_large');
        req.destroy();
        return;
      }
      for (let offset = 0; offset < chunk.length; offset += CHUNK_SIZE) {
        const slice = chunk.subarray(offset, Math.min(chunk.length, offset + CHUNK_SIZE));
        sendChunk(encodeBinaryChunk(CHUNK_REQ, streamId, slice));
      }
    });
    req.on('end', () => {
      if (entry.done) return;
      const endFrame = JSON.stringify({ type: 'http.req.end', streamId });
      if (isLarge) this.enqueueLow(endFrame);
      else this.enqueueHigh(endFrame);
    });
    req.on('error', () => {
      if (!entry.done) {
        this.enqueueHigh(JSON.stringify({ type: 'http.req.abort', streamId }));
        this.finishStream(streamId, true);
      }
    });
  }

  finishStream(streamId, aborted = false) {
    const entry = this.streams.get(streamId);
    if (!entry || entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    this.streams.delete(streamId);
    entry.releaseLargeSlot?.();
    if (!aborted && !entry.res.destroyed && !entry.res.writableEnded) {
      entry.res.end();
    }
  }

  failStream(streamId, status, error, code) {
    const entry = this.streams.get(streamId);
    if (!entry || entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    this.streams.delete(streamId);
    entry.releaseLargeSlot?.();
    if (!entry.res.headersSent) {
      entry.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      entry.res.end(JSON.stringify({ error, code }));
    } else if (!entry.res.destroyed) {
      entry.res.destroy();
    }
  }

  close(code = 1000, reason = 'closing') {
    if (this.closed) return;
    try { this.ws.close(code, reason); } catch {}
    this.cleanup();
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const [streamId] of [...this.streams]) {
      this.failStream(streamId, 503, '节点连接已断开', 'node_disconnected');
    }
    this.highQueue.length = 0;
    this.lowQueue.length = 0;
    this.onClose?.(this);
  }
}

export class TunnelManager {
  constructor({ store, push, onNodeStatus, onNodeEvent, maxUploadMb = 20, maxConcurrentLarge = 2 }) {
    this.store = store;
    this.push = push;
    this.onNodeStatus = onNodeStatus;
    this.onNodeEvent = onNodeEvent;
    this.maxUploadMb = maxUploadMb;
    this.maxConcurrentLarge = maxConcurrentLarge;
    this.tunnels = new Map(); // nodeId -> NodeTunnel
    this.largeInflightByUser = new Map(); // userId -> number
  }

  attachNode(ws, node) {
    const previous = this.tunnels.get(node.id);
    if (previous) previous.close(4001, 'replaced');

    const tunnel = new NodeTunnel({
      ws,
      node,
      maxUploadMb: this.maxUploadMb,
      onEvent: (kind, payload) => {
        if (kind === 'hello') {
          this.store.touchNode(node.id, { platform: payload.platform, hostname: payload.hostname });
          this.onNodeStatus?.(node.userId, this.describeNode(node.userId, node.id));
        } else if (kind === 'event') {
          this.onNodeEvent?.(node.userId, node.id, payload);
        }
      },
      onPush: payload => this.push?.notify(payload),
      onClose: closedTunnel => {
        if (this.tunnels.get(node.id) === closedTunnel) {
          this.tunnels.delete(node.id);
          this.store.touchNode(node.id);
          this.onNodeStatus?.(node.userId, this.describeNode(node.userId, node.id));
        }
      },
    });
    this.tunnels.set(node.id, tunnel);
    this.store.touchNode(node.id);
    this.onNodeStatus?.(node.userId, this.describeNode(node.userId, node.id));
    return tunnel;
  }

  disconnectNode(nodeId, reason = 'unpaired') {
    const tunnel = this.tunnels.get(nodeId);
    if (tunnel) tunnel.close(4002, reason);
  }

  updateNodeName(nodeId, name) {
    const tunnel = this.tunnels.get(nodeId);
    if (tunnel) tunnel.node.name = name;
  }

  isOnline(nodeId) {
    const tunnel = this.tunnels.get(nodeId);
    return Boolean(tunnel && !tunnel.closed && tunnel.ws.readyState === WebSocket.OPEN);
  }

  describeNode(userId, nodeId) {
    const saved = this.store.getNode(userId, nodeId);
    if (!saved) return null;
    const tunnel = this.tunnels.get(nodeId);
    const online = this.isOnline(nodeId);
    return {
      ...saved,
      online,
      connectedAt: online ? tunnel.connectedAt : null,
      protocolVersion: online ? tunnel.protocolVersion : 3,
      version: online ? tunnel.nodeVersion : null,
    };
  }

  listNodes(userId) {
    return this.store.listNodes(userId).map(saved => {
      const tunnel = this.tunnels.get(saved.id);
      const online = this.isOnline(saved.id);
      return {
        ...saved,
        online,
        connectedAt: online ? tunnel.connectedAt : null,
        protocolVersion: online ? tunnel.protocolVersion : 3,
        version: online ? tunnel.nodeVersion : null,
      };
    });
  }

  proxyNodeHttp(userId, nodeId, req, res, apiPath) {
    const saved = this.store.getNode(userId, nodeId);
    if (!saved) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '未找到该节点', code: 'node_not_found' }));
      return;
    }
    const tunnel = this.tunnels.get(nodeId);
    if (!tunnel || !this.isOnline(nodeId)) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '该电脑当前离线', code: 'node_offline' }));
      return;
    }

    const pathname = apiPath.split('?')[0];
    const isAttachmentUpload = pathname === '/api/attachments' && req.method === 'POST';
    const isAttachmentDownload = ['GET', 'HEAD'].includes(req.method) && (
      /^\/api\/attachments\/[^/]+(?:\/(?:preview|view))?$/.test(pathname) ||
      /^\/api\/files\/[^/]+\/download$/.test(pathname) ||
      /^\/api\/workspaces\/[^/]+\/file$/.test(pathname)
    );
    const contentLength = Number(req.headers['content-length'] || 0);
    const rawMaxBytes = this.maxUploadMb * 1024 * 1024;
    const maxBodyBytes = isAttachmentUpload
      ? Math.ceil(rawMaxBytes / 3) * 4 + 65536
      : 4 * 1024 * 1024;

    if (contentLength > maxBodyBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `附件不能超过 ${this.maxUploadMb} MB`, code: 'request_too_large' }));
      return;
    }

    const isLarge = isAttachmentUpload || isAttachmentDownload || contentLength > LARGE_THRESHOLD;
    let releaseLargeSlot = null;
    if (isLarge) {
      const active = this.largeInflightByUser.get(userId) || 0;
      if (active >= this.maxConcurrentLarge) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
        res.end(JSON.stringify({ error: '同时传输的附件过多，请稍候重试', code: 'transfer_concurrency_limit' }));
        return;
      }
      this.largeInflightByUser.set(userId, active + 1);
      let released = false;
      releaseLargeSlot = () => {
        if (released) return;
        released = true;
        const next = Math.max(0, (this.largeInflightByUser.get(userId) || 1) - 1);
        if (next === 0) this.largeInflightByUser.delete(userId);
        else this.largeInflightByUser.set(userId, next);
      };
    }

    tunnel.proxyHttp(req, res, apiPath, { maxBodyBytes, isLarge, releaseLargeSlot });
  }

  closeAll() {
    for (const tunnel of [...this.tunnels.values()]) {
      tunnel.close(1001, 'server_shutdown');
    }
    this.tunnels.clear();
  }
}
