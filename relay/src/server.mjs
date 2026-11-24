import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RelayStore } from './store.mjs';
import { HubPushService } from './push.mjs';
import { TunnelManager } from './tunnel.mjs';

const defaultFrontend = fileURLToPath(new URL('../../web/frontend/', import.meta.url));
const HUB_VERSION = '0.5.5';
const PROTOCOL_VERSION = 3;
const GITHUB_REPO = 'buyun00/Summon-Bot';

const staticAssets = new Map([
  ['/', ['index.html', 'text/html']],
  ...['app', 'hub', 'cache', 'avatars', 'motion', 'clients', 'usage', 'models', 'model-icons', 'summon-brand', 'canvas-overview']
    .map(name => [`/${name}.js`, [`${name}.js`, 'text/javascript']]),
  ...['style', 'group-chat', 'typography', 'summon-brand', 'motion', 'clients', 'usage', 'models', 'cybercab', 'hub']
    .map(name => [`/${name}.css`, [`${name}.css`, 'text/css']]),
  ['/icons/user-avatar.jpg', ['icons/user-avatar.jpg', 'image/jpeg']],
  ['/icons/owner-paper-frame.png', ['icons/owner-paper-frame.png', 'image/png']],
  ['/icons/ai-brands.svg', ['icons/ai-brands.svg', 'image/svg+xml']],
  ['/icons/ai-brands-LICENSE.txt', ['icons/ai-brands-LICENSE.txt', 'text/plain']],
  ...['icon-192', 'icon-512', 'apple-touch-icon']
    .map(name => [`/icons/${name}.png`, [`icons/${name}.png`, 'image/png']]),
]);

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req, limit = 65536) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'request_too_large' });
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    throw Object.assign(new Error('请求 JSON 格式无效'), { status: 400, code: 'invalid_json' });
  }
}

function isHttpsRequest(req, trustProxy) {
  if (req.socket?.encrypted) return true;
  if (trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
  }
  return false;
}

function parseCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return '';
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ maxPerKey = 20, maxGlobal = 200, windowMs = 60_000 } = {}) {
  const entries = new Map();
  let globalReset = 0;
  let globalCount = 0;
  return key => {
    const now = Date.now();
    if (now >= globalReset) {
      globalReset = now + windowMs;
      globalCount = 0;
    }
    for (const [k, v] of entries) {
      if (v.reset <= now) entries.delete(k);
    }
    let item = entries.get(key);
    if (!item) {
      if (entries.size >= 4096) return false;
      item = { count: 0, reset: now + windowMs };
      entries.set(key, item);
    }
    item.count += 1;
    globalCount += 1;
    return item.count <= maxPerKey && globalCount <= maxGlobal;
  };
}

function createGithubReleaseCatalog(repo = GITHUB_REPO) {
  let cache = { at: 0, value: null };
  const tags = [
    ['windows', 'x64', 'client-windows-x64'],
    ['macos', 'arm64', 'client-macos-arm64'],
    ['android', 'universal', 'client-android-universal'],
  ];
  return async () => {
    if (cache.value && Date.now() - cache.at < 300_000) return cache.value;
    const releases = [];
    let githubError = '';
    await Promise.all(tags.map(async ([platform, arch, tag]) => {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'summon-relay' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const manifestAsset = (data.assets || []).find(a => a.name === 'latest.json');
        const mainAsset = (data.assets || []).find(a => /\.(exe|dmg|apk)$/i.test(a.name));
        let version = String(data.name || '').replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1') || '';
        if (manifestAsset?.browser_download_url) {
          const mRes = await fetch(manifestAsset.browser_download_url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
          if (mRes?.ok) {
            const mJson = await mRes.json().catch(() => null);
            if (mJson?.version) version = mJson.version;
          }
        }
        if (mainAsset) {
          releases.push({
            platform,
            arch,
            version: version || HUB_VERSION,
            downloadUrl: mainAsset.browser_download_url,
            files: (data.assets || []).map(a => ({ name: a.name, size: a.size, url: a.browser_download_url })),
          });
        }
      } catch {
        githubError = '暂无法从 GitHub 读取部分发行包';
      }
    }));
    const value = { githubRepository: repo, releases, ...(githubError ? { githubError } : {}) };
    cache = { at: Date.now(), value };
    return value;
  };
}

export async function startRelayServer({
  host = '127.0.0.1',
  port = 8790,
  dataDir = resolve(process.cwd(), 'relay-data'),
  frontendRoot = defaultFrontend,
  maxUploadMb = 20,
  maxConcurrentLarge = 2,
  trustProxy = true,
  bootstrapInvite = '',
} = {}) {
  const store = new RelayStore(join(dataDir, 'relay.sqlite'));
  const createdBootstrapInvite = store.ensureBootstrapInvite(bootstrapInvite);
  const push = await new HubPushService({ store, configDir: join(dataDir, 'config') }).initialize();

  const sseByUser = new Map(); // userId -> Set<res>
  function broadcastUser(userId, payload) {
    const clients = sseByUser.get(userId);
    if (!clients || !clients.size) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 131072) client.destroy();
      else client.write(frame);
    }
  }

  const tunnels = new TunnelManager({
    store,
    push,
    maxUploadMb,
    maxConcurrentLarge,
    onNodeStatus: (userId, node) => {
      if (!node) return;
      broadcastUser(userId, { type: 'node.status', nodeId: node.id, online: node.online, node });
    },
    onNodeEvent: (userId, nodeId, event) => {
      broadcastUser(userId, { type: 'node.event', nodeId, event });
    },
  });

  const authRateLimit = createRateLimiter({ maxPerKey: 25, maxGlobal: 300, windowMs: 60_000 });
  const getReleases = createGithubReleaseCatalog();
  let modelIconSprite;
  const loadModelIconSprite = () => modelIconSprite ??= readFile(join(frontendRoot, 'icons/ai-brands.svg'), 'utf8')
    .then(sprite => sprite.replace('<svg ', '<svg aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;fill:currentColor;stroke:none" '))
    .catch(() => '');

  function sessionCookieName(req) {
    return isHttpsRequest(req, trustProxy) ? '__Host-summon_hub_session' : 'summon_hub_session';
  }

  function buildSessionCookie(req, token, clear = false) {
    const secure = isHttpsRequest(req, trustProxy);
    const name = sessionCookieName(req);
    if (clear) return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
    return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`;
  }

  function authenticateRequest(req) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      return store.verifySessionToken(token);
    }
    const cookieToken = parseCookie(req, sessionCookieName(req));
    if (cookieToken) return store.verifySessionToken(cookieToken);
    return null;
  }

  let closing = false;
  const server = createServer(async (req, res) => {
    try {
      if (closing) return json(res, 503, { error: '中枢服务正在重启', code: 'restarting' });
      const url = new URL(req.url || '/', 'http://relay.local');
      const pathname = url.pathname;

      if (pathname === '/sw.js' && ['GET', 'HEAD'].includes(req.method)) {
        const script = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('relay-shell-'))await caches.delete(name);await self.clients.claim();await self.registration.unregister();})()));`;
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
        res.end(req.method === 'HEAD' ? undefined : script);
        return;
      }

      if (pathname === '/hub/health' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          mode: 'hub',
          version: HUB_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          maxUploadMb,
          push: push.status(),
        });
      }

      if (pathname === '/api/releases' && req.method === 'GET') {
        const catalog = await getReleases();
        return json(res, 200, catalog);
      }

      if (pathname === '/hub/auth/register' && req.method === 'POST') {
        if (!authRateLimit(clientIp(req, trustProxy))) {
          return json(res, 429, { error: '操作过于频繁，请一分钟后重试', code: 'rate_limited' }, { 'Retry-After': '60' });
        }
        const body = await readJsonBody(req);
        const user = store.registerWithInvite({
          inviteCode: body.inviteCode,
          username: body.username,
          password: body.password,
          displayName: body.displayName,
        });
        const session = store.createSession(user.id, {
          kind: body.clientType || 'web',
          label: body.deviceLabel || body.clientType || 'web',
        });
        const headers = (!body.clientType || body.clientType === 'web')
          ? { 'Set-Cookie': buildSessionCookie(req, session.token) }
          : {};
        return json(res, 201, {
          user,
          session: { id: session.id, kind: session.kind, label: session.label, expiresAt: session.expiresAt },
          token: session.token,
          maxUploadMb,
          protocolVersion: PROTOCOL_VERSION,
        }, headers);
      }

      if (pathname === '/hub/auth/login' && req.method === 'POST') {
        if (!authRateLimit(clientIp(req, trustProxy))) {
          return json(res, 429, { error: '登录尝试过于频繁，请一分钟后重试', code: 'rate_limited' }, { 'Retry-After': '60' });
        }
        const body = await readJsonBody(req);
        const user = store.authenticateUser(body.username, body.password);
        if (!user) return json(res, 401, { error: '用户名或密码错误', code: 'invalid_credentials' });
        const session = store.createSession(user.id, {
          kind: body.clientType || 'web',
          label: body.deviceLabel || body.clientType || 'web',
        });
        const headers = (!body.clientType || body.clientType === 'web')
          ? { 'Set-Cookie': buildSessionCookie(req, session.token) }
          : {};
        return json(res, 200, {
          user,
          session: { id: session.id, kind: session.kind, label: session.label, expiresAt: session.expiresAt },
          token: session.token,
          maxUploadMb,
          protocolVersion: PROTOCOL_VERSION,
        }, headers);
      }

      // Serve static frontend assets (no user business data)
      if (!pathname.startsWith('/hub/') && !pathname.startsWith('/nodes/') && !pathname.startsWith('/api/')) {
        const entry = staticAssets.get(pathname);
        if (!entry || !['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const [filename, mime] = entry;
        const fullPath = join(frontendRoot, filename);
        if (!existsSync(fullPath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const asset = await readFile(fullPath);
        const sprite = filename === 'index.html' ? await loadModelIconSprite() : '';
        const content = filename === 'index.html'
          ? Buffer.from(asset.toString('utf8').replace('<!-- MODEL_ICON_SPRITE -->', () => sprite))
          : asset;
        res.writeHead(200, {
          'Content-Type': mime.startsWith('image/') ? mime : `${mime}; charset=utf-8`,
          'Content-Length': content.length,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }

      // Everything under /hub/* (except health/login/register) and /nodes/* requires authentication
      const auth = authenticateRequest(req);
      if (!auth) {
        return json(res, 401, { error: '请先登录 Summon Bot 账号', code: 'unauthorized' });
      }
      const { user, session } = auth;

      if (pathname === '/hub/auth/me' && req.method === 'GET') {
        return json(res, 200, {
          mode: 'hub',
          user,
          session,
          maxUploadMb,
          protocolVersion: PROTOCOL_VERSION,
          hubVersion: HUB_VERSION,
          push: push.status(),
        });
      }

      if (pathname === '/hub/auth/logout' && req.method === 'POST') {
        store.deleteSession(user.id, session.id);
        return json(res, 200, { ok: true }, { 'Set-Cookie': buildSessionCookie(req, '', true) });
      }

      if (pathname === '/hub/auth/password' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const valid = store.authenticateUser(user.username, body.currentPassword);
        if (!valid) return json(res, 401, { error: '当前密码不正确', code: 'invalid_credentials' });
        store.updatePassword(user.id, body.newPassword, session.id);
        return json(res, 200, { ok: true });
      }

      if (pathname === '/hub/devices' && req.method === 'GET') {
        return json(res, 200, { devices: store.listSessions(user.id), currentSessionId: session.id });
      }

      let match;
      if ((match = pathname.match(/^\/hub\/devices\/([^/]+)$/)) && req.method === 'DELETE') {
        const id = decodeURIComponent(match[1]);
        const removed = store.deleteSession(user.id, id);
        return json(res, removed ? 200 : 404, removed ? { removed: true } : { error: '未找到该设备会话' });
      }

      if (pathname === '/hub/nodes' && req.method === 'GET') {
        return json(res, 200, { nodes: tunnels.listNodes(user.id) });
      }

      if (pathname === '/hub/nodes/pair' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const paired = store.pairNode(user.id, {
          name: body.name,
          platform: body.platform,
          hostname: body.hostname,
        });
        broadcastUser(user.id, { type: 'node.status', nodeId: paired.id, online: false, node: tunnels.describeNode(user.id, paired.id) });
        return json(res, 201, {
          nodeId: paired.id,
          nodeSecret: paired.nodeSecret,
          name: paired.name,
          platform: paired.platform,
          hostname: paired.hostname,
        });
      }

      if ((match = pathname.match(/^\/hub\/nodes\/([^/]+)$/)) && req.method === 'PATCH') {
        const nodeId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req);
        const updated = store.renameNode(user.id, nodeId, body.name);
        if (!updated) return json(res, 404, { error: '未找到该节点' });
        tunnels.updateNodeName(nodeId, updated.name);
        const described = tunnels.describeNode(user.id, nodeId);
        broadcastUser(user.id, { type: 'node.status', nodeId, online: described.online, node: described });
        return json(res, 200, { node: described });
      }

      if ((match = pathname.match(/^\/hub\/nodes\/([^/]+)$/)) && req.method === 'DELETE') {
        const nodeId = decodeURIComponent(match[1]);
        tunnels.disconnectNode(nodeId, 'unpaired');
        const removed = store.deleteNode(user.id, nodeId);
        if (!removed) return json(res, 404, { error: '未找到该节点' });
        broadcastUser(user.id, { type: 'node.removed', nodeId });
        return json(res, 200, { removed: true });
      }

      if (pathname === '/hub/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let set = sseByUser.get(user.id);
        if (!set) {
          set = new Set();
          sseByUser.set(user.id, set);
        }
        set.add(res);
        res.write(`data: ${JSON.stringify({ type: 'connected', nodes: tunnels.listNodes(user.id) })}\n\n`);
        res.on('close', () => {
          set.delete(res);
          if (!set.size) sseByUser.delete(user.id);
        });
        return;
      }

      if (pathname === '/hub/push/register' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return json(res, 200, push.register(user.id, body));
      }

      if ((match = pathname.match(/^\/hub\/push\/register\/([^/]+)$/)) && req.method === 'DELETE') {
        const deviceId = decodeURIComponent(match[1]);
        return json(res, 200, push.remove(user.id, deviceId));
      }

      // Admin endpoints (invite management & user management)
      if (pathname.startsWith('/hub/admin/')) {
        if (user.role !== 'admin') return json(res, 403, { error: '需要管理员权限', code: 'forbidden' });
        if (pathname === '/hub/admin/invites' && req.method === 'GET') {
          return json(res, 200, { invites: store.listInvites() });
        }
        if (pathname === '/hub/admin/invites' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const invite = store.createInvite({
            code: body.code || undefined,
            role: body.role === 'admin' ? 'admin' : 'user',
            createdBy: user.username,
            note: body.note || '',
            maxUses: Number(body.maxUses) || 1,
            expiresAt: body.expiresDays ? new Date(Date.now() + Number(body.expiresDays) * 86400000).toISOString() : null,
          });
          return json(res, 201, { invite });
        }
        if ((match = pathname.match(/^\/hub\/admin\/invites\/([^/]+)$/)) && req.method === 'DELETE') {
          const ok = store.revokeInvite(decodeURIComponent(match[1]));
          return json(res, ok ? 200 : 404, ok ? { revoked: true } : { error: '未找到邀请码' });
        }
        if (pathname === '/hub/admin/users' && req.method === 'GET') {
          return json(res, 200, { users: store.listUsers() });
        }
        if ((match = pathname.match(/^\/hub\/admin\/users\/([^/]+)$/)) && req.method === 'PATCH') {
          const targetId = decodeURIComponent(match[1]);
          const body = await readJsonBody(req);
          if (typeof body.disabled === 'boolean') {
            if (targetId === user.id && body.disabled) return json(res, 400, { error: '不能停用当前管理员账号' });
            store.setUserDisabled(targetId, body.disabled);
          }
          return json(res, 200, { user: store.getUserById(targetId) });
        }
        return json(res, 404, { error: '未找到管理接口' });
      }

      // Proxy /nodes/:nodeId/api/* -> Node WSS Tunnel
      if ((match = pathname.match(/^\/nodes\/([^/]+)(\/api\/.*)$/))) {
        const nodeId = decodeURIComponent(match[1]);
        const apiPath = `${match[2]}${url.search}`;
        tunnels.proxyNodeHttp(user.id, nodeId, req, res, apiPath);
        return;
      }

      json(res, 404, { error: 'Route not found', code: 'not_found' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error.status || 500;
      json(res, status, { error: error.message || '中枢处理请求失败', code: error.code || 'hub_error' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://relay.local');
      if (url.pathname !== '/hub/node-ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const authHeader = req.headers.authorization || '';
      let nodeId = '';
      let nodeSecret = '';
      if (authHeader.startsWith('Bearer ')) {
        const raw = authHeader.slice(7).trim();
        const sep = raw.indexOf(':');
        if (sep > 0) {
          nodeId = raw.slice(0, sep);
          nodeSecret = raw.slice(sep + 1);
        }
      }
      if (nodeId && nodeSecret) {
        const node = store.authenticateNode(nodeId, nodeSecret);
        if (!node) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
          tunnels.attachNode(ws, node);
        });
        return;
      }
      // Allow first-frame JSON auth over TLS WSS for zero-dependency Node 24 WebSocket clients.
      wss.handleUpgrade(req, socket, head, ws => {
        const authTimer = setTimeout(() => {
          try { ws.close(4003, 'auth_timeout'); } catch {}
        }, 5000);
        ws.once('message', (data, isBinary) => {
          clearTimeout(authTimer);
          if (isBinary) { try { ws.close(4003, 'auth_required'); } catch {} return; }
          let msg;
          try { msg = JSON.parse(data.toString('utf8')); } catch { try { ws.close(4003, 'invalid_auth'); } catch {} return; }
          if (msg?.type !== 'auth') { try { ws.close(4003, 'auth_required'); } catch {} return; }
          const node = store.authenticateNode(msg.nodeId, msg.nodeSecret);
          if (!node) { try { ws.close(4001, 'unauthorized'); } catch {} return; }
          if (typeof msg.platform === 'string') node.platform = msg.platform;
          if (typeof msg.hostname === 'string') node.hostname = msg.hostname;
          const tunnel = tunnels.attachNode(ws, node);
          if (typeof msg.version === 'string') tunnel.nodeVersion = msg.version;
          if (typeof msg.protocolVersion === 'number') tunnel.protocolVersion = msg.protocolVersion;
          store.touchNode(node.id, { platform: node.platform, hostname: node.hostname });
          broadcastUser(node.userId, { type: 'node.status', nodeId: node.id, online: true, node: tunnels.describeNode(node.userId, node.id) });
        });
        ws.once('close', () => clearTimeout(authTimer));
      });
    } catch {
      socket.destroy();
    }
  });

  const sseHeartbeat = setInterval(() => {
    for (const set of sseByUser.values()) {
      for (const res of set) {
        if (res.writableLength > 65536) res.destroy();
        else res.write(': ping\n\n');
      }
    }
  }, 20_000);
  sseHeartbeat.unref();

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  const addr = server.address();
  const listenUrl = `http://${host}:${addr.port}`;

  return {
    url: listenUrl,
    bootstrapInvite: createdBootstrapInvite,
    server,
    store,
    tunnels,
    async close() {
      closing = true;
      clearInterval(sseHeartbeat);
      tunnels.closeAll();
      for (const set of sseByUser.values()) for (const res of set) res.end();
      sseByUser.clear();
      await push.close();
      await new Promise(done => { server.close(done); server.closeAllConnections?.(); });
      store.close();
    },
  };
}
