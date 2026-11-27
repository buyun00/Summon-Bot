import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { hostname as osHostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_HUB_URL = 'https://8.163.53.156';
const CHUNK_REQ = 1;
const CHUNK_RES = 2;
const CHUNK_SIZE = 64 * 1024;
const PROTOCOL_VERSION = 3;

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

export function normalizeHubUrl(raw) {
  const value = String(raw || DEFAULT_HUB_URL).trim();
  let url;
  try { url = new URL(value); } catch {
    throw Object.assign(new Error('请输入有效的中枢地址，例如 https://8.163.53.156'), { status: 400, code: 'invalid_hub_url' });
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('中枢地址格式无效'), { status: 400, code: 'invalid_hub_url' });
  }
  const cleanPath = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${cleanPath}`;
}

export class RelayConnector {
  constructor({ dataRoot, gatewayUrl, gatewayToken, version = '0.5.5' }) {
    this.dataRoot = dataRoot;
    this.configPath = dataRoot ? join(dataRoot, 'config', 'relay.json') : null;
    this.gatewayUrl = new URL(gatewayUrl);
    this.gatewayToken = gatewayToken;
    this.version = version;

    this.state = {
      hubUrl: DEFAULT_HUB_URL,
      localNodeId: randomUUID(),
      nodeId: null,
      nodeSecret: null,
      nodeName: osHostname() || '我的电脑',
      userToken: null,
      user: null,
    };

    this.ws = null;
    this.hubConnected = false;
    this.hubError = '';
    this.maxUploadMb = 20;
    this.closed = false;
    this.wsReconnectTimer = null;
    this.wsBackoffMs = 1500;
    this.tunnelStreams = new Map();
    this.localSseClients = new Set();
    this.gatewayStreamReq = null;
    this.gatewayStreamTimer = null;
    this.hubEventsAbort = null;
    this.hubEventsTimer = null;
    this.remoteNodesCache = [];
  }

  async initialize() {
    await this.loadConfig();
    this.startGatewayEventBridge();
    if (this.state.nodeId && this.state.nodeSecret) {
      this.connectTunnel();
    }
    if (this.state.userToken) {
      this.startHubEventsBridge();
    }
    this.heartbeat = setInterval(() => {
      for (const res of this.localSseClients) {
        if (res.writableLength > 65536) res.destroy();
        else res.write(': ping\n\n');
      }
    }, 20_000);
    this.heartbeat.unref();
    return this;
  }

  async loadConfig() {
    if (!this.configPath) return;
    try {
      const saved = JSON.parse(await readFile(this.configPath, 'utf8'));
      if (saved && typeof saved === 'object') {
        const rawHubUrl = typeof saved.hubUrl === 'string' ? saved.hubUrl.trim().replace(/\/+$/, '') : '';
        const migratedHub = rawHubUrl.toLowerCase() === 'https://bot.lin0.org';
        this.state = {
          hubUrl: (!rawHubUrl || migratedHub) ? DEFAULT_HUB_URL : saved.hubUrl,
          localNodeId: saved.localNodeId || saved.nodeId || randomUUID(),
          nodeId: saved.nodeId || null,
          nodeSecret: saved.nodeSecret || null,
          nodeName: saved.nodeName || osHostname() || '我的电脑',
          userToken: saved.userToken || null,
          user: saved.user || null,
        };
        if (migratedHub) await this.saveConfig().catch(() => {});
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Failed to read relay.json:', error.message);
      await this.saveConfig().catch(() => {});
    }
  }

  async saveConfig() {
    if (!this.configPath) return;
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(tmp, this.configPath);
  }

  activeLocalNodeId() {
    return this.state.nodeId || this.state.localNodeId;
  }

  isLocalNode(nodeId) {
    if (!nodeId) return false;
    return nodeId === 'local' || nodeId === this.state.localNodeId || (Boolean(this.state.nodeId) && nodeId === this.state.nodeId);
  }

  localNodeDescriptor() {
    return {
      id: this.activeLocalNodeId(),
      name: this.state.nodeName || osHostname() || '我的电脑',
      platform: process.platform,
      hostname: osHostname() || '',
      online: true,
      isLocal: true,
      hubPaired: Boolean(this.state.nodeId && this.state.nodeSecret),
      hubConnected: this.hubConnected,
      protocolVersion: PROTOCOL_VERSION,
      version: this.version,
      lastSeenAt: new Date().toISOString(),
    };
  }

  broadcastLocalSse(payload) {
    if (!this.localSseClients.size) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.localSseClients) {
      if (res.writableLength > 131072) res.destroy();
      else res.write(line);
    }
  }

  // --- Local Gateway SSE Bridge ---
  startGatewayEventBridge() {
    if (this.closed) return;
    clearTimeout(this.gatewayStreamTimer);
    if (this.gatewayStreamReq) {
      try { this.gatewayStreamReq.destroy(); } catch {}
      this.gatewayStreamReq = null;
    }

    const target = new URL(`/api/stream?protocol=${PROTOCOL_VERSION}`, this.gatewayUrl);
    const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.gatewayToken}`, Accept: 'text/event-stream' },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        this.scheduleGatewayReconnect();
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            let event;
            try { event = JSON.parse(raw); } catch { continue; }
            if (event.type === 'push.notify') {
              this.sendTunnelJson({
                type: 'push.notify',
                roomId: event.roomId,
                roomName: event.roomName,
                roomMode: event.roomMode,
                senderId: event.senderId,
                senderName: event.senderName,
                messageId: event.messageId,
                preview: event.preview,
                notificationId: event.notificationId,
                createdAt: event.createdAt,
              });
              continue;
            }
            if (event.type === 'connected') continue;
            this.broadcastLocalSse({ type: 'node.event', nodeId: this.activeLocalNodeId(), event });
            this.sendTunnelJson({ type: 'node.event', event });
          }
        }
      });
      res.on('end', () => this.scheduleGatewayReconnect());
      res.on('error', () => this.scheduleGatewayReconnect());
    });
    req.on('error', () => this.scheduleGatewayReconnect());
    req.end();
    this.gatewayStreamReq = req;
  }

  scheduleGatewayReconnect() {
    if (this.closed) return;
    clearTimeout(this.gatewayStreamTimer);
    this.gatewayStreamTimer = setTimeout(() => this.startGatewayEventBridge(), 2000);
    this.gatewayStreamTimer.unref();
  }

  // --- Outbound WSS Tunnel to Relay Hub ---
  sendTunnelJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  sendTunnelBinary(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(buf); return true; } catch { return false; }
  }

  connectTunnel() {
    if (this.closed || !this.state.nodeId || !this.state.nodeSecret) return;
    clearTimeout(this.wsReconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const base = new URL(this.state.hubUrl);
    const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsPath = `${base.pathname.replace(/\/+$/, '')}/hub/node-ws`;
    const wsUrl = `${wsProtocol}//${base.host}${wsPath}`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch (error) {
      this.hubError = error.message || '中枢地址无效';
      this.scheduleTunnelReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.wsBackoffMs = 1500;
      this.hubError = '';
      this.sendTunnelJson({
        type: 'auth',
        nodeId: this.state.nodeId,
        nodeSecret: this.state.nodeSecret,
        platform: process.platform,
        hostname: osHostname() || '',
        version: this.version,
        protocolVersion: PROTOCOL_VERSION,
      });
    });

    ws.addEventListener('message', event => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this.handleTunnelText(msg);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleTunnelBinary(Buffer.from(event.data));
      } else if (ArrayBuffer.isView(event.data)) {
        this.handleTunnelBinary(Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength));
      }
    });

    ws.addEventListener('close', async ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasConnected = this.hubConnected;
      this.hubConnected = false;
      this.abortAllTunnelStreams();
      if (wasConnected) {
        this.broadcastLocalSse({ type: 'node.status', nodeId: this.activeLocalNodeId(), online: true, node: this.localNodeDescriptor() });
      }
      if (ev.code === 4002 || ev.code === 4001) {
        this.hubError = ev.code === 4002 ? '此电脑已被解绑，请重新登录中枢' : '节点凭据已失效，请重新登录中枢';
        if (ev.code === 4002) {
          this.state.nodeId = null;
          this.state.nodeSecret = null;
          await this.saveConfig().catch(() => {});
        }
        return;
      }
      this.scheduleTunnelReconnect();
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.hubError = '无法连接到中枢，正在自动重连…';
    });
  }

  scheduleTunnelReconnect() {
    if (this.closed || !this.state.nodeId || !this.state.nodeSecret) return;
    clearTimeout(this.wsReconnectTimer);
    const delay = this.wsBackoffMs;
    this.wsBackoffMs = Math.min(15_000, Math.round(this.wsBackoffMs * 1.6));
    this.wsReconnectTimer = setTimeout(() => this.connectTunnel(), delay);
    this.wsReconnectTimer.unref();
  }

  abortAllTunnelStreams() {
    for (const [, stream] of this.tunnelStreams) {
      try { stream.req.destroy(); } catch {}
    }
    this.tunnelStreams.clear();
  }

  handleTunnelText(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello.ack') {
      this.hubConnected = true;
      this.hubError = '';
      if (typeof msg.maxUploadMb === 'number') this.maxUploadMb = msg.maxUploadMb;
      if (typeof msg.nodeName === 'string' && msg.nodeName && msg.nodeName !== this.state.nodeName) {
        this.state.nodeName = msg.nodeName;
        void this.saveConfig().catch(() => {});
      }
      this.broadcastLocalSse({ type: 'node.status', nodeId: this.activeLocalNodeId(), online: true, node: this.localNodeDescriptor() });
      return;
    }

    if (msg.type === 'http.req.start') {
      this.handleTunneledHttpStart(msg);
      return;
    }

    if (msg.type === 'http.req.end') {
      const entry = this.tunnelStreams.get(msg.streamId);
      if (entry && !entry.ended) {
        entry.ended = true;
        entry.req.end();
      }
      return;
    }

    if (msg.type === 'http.req.abort') {
      const entry = this.tunnelStreams.get(msg.streamId);
      if (entry) {
        this.tunnelStreams.delete(msg.streamId);
        try { entry.req.destroy(); } catch {}
      }
    }
  }

  handleTunnelBinary(buf) {
    if (buf.length < 5) return;
    const kind = buf[0];
    const streamId = buf.readUInt32BE(1);
    if (kind !== CHUNK_REQ) return;
    const entry = this.tunnelStreams.get(streamId);
    if (!entry || entry.ended) return;
    const payload = buf.subarray(5);
    entry.req.write(payload);
  }

  handleTunneledHttpStart(msg) {
    const streamId = msg.streamId;
    const path = typeof msg.path === 'string' && msg.path.startsWith('/api/') ? msg.path : null;
    if (!path) {
      this.sendTunnelJson({ type: 'http.res.error', streamId, status: 400, error: '无效的节点路径', code: 'invalid_path' });
      return;
    }
    const target = new URL(path, this.gatewayUrl);
    const headers = { Authorization: `Bearer ${this.gatewayToken}` };
    for (const [k, v] of Object.entries(msg.headers || {})) {
      const lower = k.toLowerCase();
      if (hopHeaders.has(lower)) continue;
      headers[k] = v;
    }

    const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn(target, { method: msg.method || 'GET', headers }, incoming => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(incoming.headers)) {
        const lower = k.toLowerCase();
        if (hopHeaders.has(lower) || lower === 'set-cookie' || v === undefined) continue;
        resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      const hasBody = (msg.method || 'GET') !== 'HEAD' && incoming.statusCode !== 204 && incoming.statusCode !== 304;
      this.sendTunnelJson({
        type: 'http.res.start',
        streamId,
        status: incoming.statusCode || 502,
        headers: resHeaders,
        hasBody,
      });
      if (!hasBody) {
        incoming.resume();
        this.tunnelStreams.delete(streamId);
        return;
      }
      incoming.on('data', chunk => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < buf.length; offset += CHUNK_SIZE) {
          const slice = buf.subarray(offset, Math.min(buf.length, offset + CHUNK_SIZE));
          this.sendTunnelBinary(encodeBinaryChunk(CHUNK_RES, streamId, slice));
        }
      });
      incoming.on('end', () => {
        this.tunnelStreams.delete(streamId);
        this.sendTunnelJson({ type: 'http.res.end', streamId });
      });
      incoming.on('error', () => {
        this.tunnelStreams.delete(streamId);
        this.sendTunnelJson({ type: 'http.res.error', streamId, status: 502, error: '本机网关响应中断', code: 'gateway_stream_error' });
      });
    });

    req.on('error', () => {
      this.tunnelStreams.delete(streamId);
      this.sendTunnelJson({ type: 'http.res.error', streamId, status: 502, error: '本机网关不可达', code: 'gateway_unreachable' });
    });

    this.tunnelStreams.set(streamId, { req, ended: false });
    if (!msg.hasBody) {
      this.tunnelStreams.get(streamId).ended = true;
      req.end();
    }
  }

  // --- Remote Hub SSE Bridge (for Local Desktop to see other PCs in real-time) ---
  startHubEventsBridge() {
    this.stopHubEventsBridge();
    if (this.closed || !this.state.userToken) return;
    const abort = new AbortController();
    this.hubEventsAbort = abort;

    const run = async () => {
      try {
        const res = await fetch(`${this.state.hubUrl}/hub/events`, {
          headers: { Authorization: `Bearer ${this.state.userToken}`, Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 401) {
            this.hubError = '中枢登录已失效，请重新登录';
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw) continue;
              let payload;
              try { payload = JSON.parse(raw); } catch { continue; }
              if (payload.type === 'connected' && Array.isArray(payload.nodes)) {
                this.remoteNodesCache = payload.nodes;
                this.broadcastLocalSse({ type: 'nodes.sync', nodes: this.mergeNodes(payload.nodes) });
              } else if (payload.type === 'node.status' && payload.nodeId) {
                if (payload.nodeId !== this.activeLocalNodeId()) {
                  this.upsertRemoteNodeCache(payload.node);
                  this.broadcastLocalSse(payload);
                }
              } else if (payload.type === 'node.removed' && payload.nodeId) {
                this.remoteNodesCache = this.remoteNodesCache.filter(n => n.id !== payload.nodeId);
                this.broadcastLocalSse(payload);
              } else if (payload.type === 'node.event' && payload.nodeId && payload.nodeId !== this.activeLocalNodeId()) {
                this.broadcastLocalSse(payload);
              }
            }
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
      }
      if (!this.closed && !abort.signal.aborted && this.state.userToken) {
        this.hubEventsTimer = setTimeout(() => this.startHubEventsBridge(), 4000);
        this.hubEventsTimer.unref();
      }
    };
    void run();
  }

  stopHubEventsBridge() {
    clearTimeout(this.hubEventsTimer);
    if (this.hubEventsAbort) {
      this.hubEventsAbort.abort();
      this.hubEventsAbort = null;
    }
  }

  upsertRemoteNodeCache(node) {
    if (!node?.id) return;
    const idx = this.remoteNodesCache.findIndex(item => item.id === node.id);
    if (idx >= 0) this.remoteNodesCache[idx] = node;
    else this.remoteNodesCache.push(node);
  }

  mergeNodes(remoteList = this.remoteNodesCache) {
    const local = this.localNodeDescriptor();
    const result = [local];
    for (const item of remoteList || []) {
      if (!item?.id || item.id === local.id) continue;
      result.push({ ...item, isLocal: false });
    }
    return result;
  }

  // --- Hub Auth & API helpers for Local Web Server ---
  async hubFetchJson(method, path, body, { hubUrl = this.state.hubUrl, token = this.state.userToken } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${hubUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw Object.assign(new Error('无法连接到中枢服务器，请检查网络或中枢地址'), { status: 502, code: 'hub_unreachable', cause: error });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || `中枢请求失败（HTTP ${response.status}）`), {
        status: response.status,
        code: data?.code || 'hub_error',
      });
    }
    return data;
  }

  async ensurePaired(hubUrl, userToken, userId, nodeName) {
    // Reuse existing pairing if same hubUrl and node is still owned by this account
    if (this.state.nodeId && this.state.nodeSecret && this.state.hubUrl === hubUrl && this.state.user?.id === userId) {
      try {
        const list = await this.hubFetchJson('GET', '/hub/nodes', undefined, { hubUrl, token: userToken });
        if ((list.nodes || []).some(n => n.id === this.state.nodeId)) {
          return { nodeId: this.state.nodeId, nodeSecret: this.state.nodeSecret, name: this.state.nodeName };
        }
      } catch {}
    }
    const paired = await this.hubFetchJson('POST', '/hub/nodes/pair', {
      name: nodeName || this.state.nodeName || osHostname() || '我的电脑',
      platform: process.platform,
      hostname: osHostname() || '',
    }, { hubUrl, token: userToken });
    return { nodeId: paired.nodeId, nodeSecret: paired.nodeSecret, name: paired.name };
  }

  async authWithHub(mode, payload) {
    const hubUrl = normalizeHubUrl(payload.hubUrl || this.state.hubUrl || DEFAULT_HUB_URL);
    const endpoint = mode === 'register' ? '/hub/auth/register' : '/hub/auth/login';
    const reqBody = mode === 'register'
      ? {
        inviteCode: payload.inviteCode,
        username: payload.username,
        password: payload.password,
        displayName: payload.displayName,
        clientType: 'desktop',
        deviceLabel: `${osHostname() || 'PC'} (${process.platform})`,
      }
      : {
        username: payload.username,
        password: payload.password,
        clientType: 'desktop',
        deviceLabel: `${osHostname() || 'PC'} (${process.platform})`,
      };
    const result = await this.hubFetchJson('POST', endpoint, reqBody, { hubUrl, token: null });
    const paired = await this.ensurePaired(hubUrl, result.token, result.user.id, payload.nodeName);
    this.state = {
      hubUrl,
      localNodeId: paired.nodeId,
      nodeId: paired.nodeId,
      nodeSecret: paired.nodeSecret,
      nodeName: paired.name,
      userToken: result.token,
      user: result.user,
    };
    this.maxUploadMb = result.maxUploadMb || 20;
    await this.saveConfig();
    this.connectTunnel();
    this.startHubEventsBridge();
    return this.getAuthMe();
  }

  async logoutHub() {
    if (this.state.userToken) {
      await this.hubFetchJson('POST', '/hub/auth/logout', {}).catch(() => {});
    }
    this.stopHubEventsBridge();
    if (this.ws) {
      try { this.ws.close(1000, 'logout'); } catch {}
      this.ws = null;
    }
    this.hubConnected = false;
    this.hubError = '';
    this.remoteNodesCache = [];
    this.state.userToken = null;
    this.state.user = null;
    await this.saveConfig();
    this.broadcastLocalSse({ type: 'nodes.sync', nodes: this.mergeNodes([]) });
    return { ok: true };
  }

  async getAuthMe() {
    if (this.state.userToken) {
      try {
        const remote = await this.hubFetchJson('GET', '/hub/auth/me');
        if (remote?.user) {
          this.state.user = remote.user;
          if (typeof remote.maxUploadMb === 'number') this.maxUploadMb = remote.maxUploadMb;
          void this.saveConfig().catch(() => {});
        }
      } catch (error) {
        if (error.status === 401) {
          this.hubError = '中枢会话已过期，请重新登录';
        }
      }
    }
    return {
      mode: 'local',
      authenticated: Boolean(this.state.userToken && this.state.user),
      localOnlyAvailable: true,
      user: this.state.user,
      hubUrl: this.state.hubUrl,
      hubConnected: this.hubConnected,
      hubError: this.hubError || '',
      localNodeId: this.activeLocalNodeId(),
      localNodeName: this.state.nodeName,
      maxUploadMb: this.maxUploadMb,
      protocolVersion: PROTOCOL_VERSION,
      hubVersion: this.version,
    };
  }

  async listNodes() {
    if (this.state.userToken) {
      try {
        const data = await this.hubFetchJson('GET', '/hub/nodes');
        if (Array.isArray(data?.nodes)) this.remoteNodesCache = data.nodes;
      } catch {}
    }
    return this.mergeNodes(this.remoteNodesCache);
  }

  async renameNode(nodeId, name) {
    const clean = String(name || '').trim().slice(0, 48);
    if (!clean) throw Object.assign(new Error('节点名称不能为空'), { status: 400 });
    if (this.isLocalNode(nodeId)) {
      this.state.nodeName = clean;
      await this.saveConfig();
      if (this.state.userToken && this.state.nodeId) {
        await this.hubFetchJson('PATCH', `/hub/nodes/${encodeURIComponent(this.state.nodeId)}`, { name: clean }).catch(() => {});
      }
      const node = this.localNodeDescriptor();
      this.broadcastLocalSse({ type: 'node.status', nodeId: node.id, online: true, node });
      return { node };
    }
    if (!this.state.userToken) throw Object.assign(new Error('请先登录中枢账号'), { status: 401 });
    return this.hubFetchJson('PATCH', `/hub/nodes/${encodeURIComponent(nodeId)}`, { name: clean });
  }

  async deleteNode(nodeId) {
    if (!this.state.userToken) throw Object.assign(new Error('请先登录中枢账号'), { status: 401 });
    const res = await this.hubFetchJson('DELETE', `/hub/nodes/${encodeURIComponent(nodeId)}`);
    if (this.isLocalNode(nodeId)) {
      if (this.ws) { try { this.ws.close(1000, 'unpaired'); } catch {} this.ws = null; }
      this.hubConnected = false;
      this.state.nodeId = null;
      this.state.nodeSecret = null;
      await this.saveConfig();
    } else {
      this.remoteNodesCache = this.remoteNodesCache.filter(n => n.id !== nodeId);
    }
    this.broadcastLocalSse({ type: 'node.removed', nodeId });
    return res;
  }

  subscribeEvents(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    });
    this.localSseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', nodes: this.mergeNodes() })}\n\n`);
    res.on('close', () => this.localSseClients.delete(res));
  }

  proxyRemoteNodeHttp(nodeId, req, res, apiPath, timeoutMs = 120_000) {
    if (!this.state.userToken) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '请先登录中枢账号以访问其他电脑', code: 'hub_login_required' }));
      return;
    }
    const target = new URL(`/nodes/${encodeURIComponent(nodeId)}${apiPath}`, this.state.hubUrl);
    const writes = !['GET', 'HEAD'].includes(req.method);
    const headers = {
      Authorization: `Bearer ${this.state.userToken}`,
      Accept: req.headers.accept || '*/*',
    };
    if (typeof req.headers['x-summon-protocol'] === 'string') headers['X-Summon-Protocol'] = req.headers['x-summon-protocol'];
    if (typeof req.headers['x-summon-client-id'] === 'string') headers['X-Summon-Client-Id'] = req.headers['x-summon-client-id'];
    if (writes && req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (writes && req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];

    const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = reqFn(target, { method: req.method, headers }, incoming => {
      const responseHeaders = Object.fromEntries(
        Object.entries(incoming.headers).filter(([k]) => !hopHeaders.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie'),
      );
      responseHeaders['Cache-Control'] = 'private, no-store, no-transform';
      responseHeaders['X-Content-Type-Options'] = 'nosniff';
      res.writeHead(incoming.statusCode || 502, responseHeaders);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    outgoing.once('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '远程节点暂不可达', code: 'remote_node_unreachable' }));
      } else {
        res.destroy();
      }
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('Remote node request timed out')));
    req.once('error', error => outgoing.destroy(error));
    res.once('close', () => outgoing.destroy());
    if (writes) req.pipe(outgoing);
    else outgoing.end();
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.wsReconnectTimer);
    clearTimeout(this.gatewayStreamTimer);
    this.stopHubEventsBridge();
    this.abortAllTunnelStreams();
    if (this.gatewayStreamReq) { try { this.gatewayStreamReq.destroy(); } catch {} }
    if (this.ws) { try { this.ws.close(1001, 'shutdown'); } catch {} }
    for (const res of this.localSseClients) res.end();
    this.localSseClients.clear();
  }
}
