import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { serveClientReleases } from './releases.mjs';
import { createWebAuth } from './auth.mjs';
import { matchesOrigin, originForHost, instanceOrigin } from './origins.mjs';
import { instanceProof } from './instance-probe.mjs';
import { createGameExports, gamePrefix } from './game-exports.mjs';

const defaultFrontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ...['app', 'cache', 'avatars', 'motion', 'clients', 'usage', 'models', 'model-icons', 'summon-brand', 'branding-migration'].map(name => [`/${name}.js`, [`${name}.js`, 'text/javascript']]),
  ...['style', 'mobile', 'group-chat', 'typography', 'summon-brand', 'motion', 'clients', 'usage', 'models', 'cybercab'].map(name => [`/${name}.css`, [`${name}.css`, 'text/css']]),
  ['/icons/user-avatar.jpg', ['icons/user-avatar.jpg', 'image/jpeg']],
  ['/icons/owner-paper-frame.png', ['icons/owner-paper-frame.png', 'image/png']],
  ['/icons/ai-brands.svg', ['icons/ai-brands.svg', 'image/svg+xml']],
  ['/icons/ai-brands-LICENSE.txt', ['icons/ai-brands-LICENSE.txt', 'text/plain']],
  ...['icon-192', 'icon-512', 'icon-maskable-192', 'icon-maskable-512', 'apple-touch-icon']
    .map(name => [`/icons/${name}.png`, [`icons/${name}.png`, 'image/png']]),
]);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};

// This prefix also bypasses older installed chat service workers' navigation cache.
const showcasePrefix = '/api/avatar-showcase/';
const showcaseMime = new Map([
  ['html', 'text/html'], ['js', 'text/javascript'], ['css', 'text/css'],
  ['svg', 'image/svg+xml'], ['png', 'image/png'], ['ico', 'image/x-icon'],
  ['wasm', 'application/wasm'], ['txt', 'text/plain'], ['woff2', 'font/woff2'],
]);

/** The Web process owns only HTTP/static assets. Business state and Agents stay outside. */
export async function startWeb({ host = '127.0.0.1', port = 8787, getRemoteOrigins = async () => [], frontendRoot = defaultFrontend,
  gatewayUrl, gatewayToken, accessToken, clientReleaseRoot, webRelease, gameExports, requestTimeoutMs = 120000 } = {}) {
  const authorize = createWebAuth(accessToken);
  const games = createGameExports(gameExports, accessToken);
  const upstream = new URL(gatewayUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw new Error('Invalid gateway URL');
  if (!gatewayToken) throw new Error('gatewayToken is required');
  // Keep symbol definitions in the document so rerendered icons never reload an external SVG.
  let modelIconSprite;
  const loadModelIconSprite = () => modelIconSprite ??= readFile(join(frontendRoot, 'icons/ai-brands.svg'), 'utf8')
    .then(sprite => sprite.replace('<svg ', '<svg aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;fill:currentColor;stroke:none" '))
    .catch(error => {
      console.warn(`Model icons unavailable: ${error.code || error.message}`);
      return '';
    });
  const active = new Set();
  let closing = false;
  async function remoteMappings() {
    let entries;
    try { entries = await getRemoteOrigins(); }
    catch { return []; }
    if (!Array.isArray(entries)) return [];
    return entries.flatMap(entry => {
      try { return [{ origin: instanceOrigin(entry.origin, { httpsOnly: true }), provider: entry.provider, probeOnly: entry.probeOnly === true }]; }
      catch { return []; }
    });
  }
  const server = createServer(async (req, res) => {
    try {
      if (closing) return json(res, 503, { error: '实例正在更新', code: 'updating' });
      const localOrigins = [host, ...(host === '127.0.0.1' ? ['localhost'] : [])].map(name => `http://${name}:${server.address().port}`);
      const localOrigin = originForHost(req.headers.host, localOrigins);
      const mappings = localOrigin ? [] : await remoteMappings();
      const requestOrigin = localOrigin || originForHost(req.headers.host, mappings.map(entry => entry.origin));
      if (!requestOrigin || !req.url?.startsWith('/') || req.url.startsWith('//')) return json(res, 403, { error: '实例地址未登记' });
      const funnel = req.headers['tailscale-funnel-request'] === '?1';
      const matched = mappings.filter(entry => entry.origin === requestOrigin);
      if (funnel && matched.some(entry => entry.provider === 'tailscale')) {
        return json(res, 403, { error: '实例使用私网 Tailscale Serve' });
      }
      const url = new URL(req.url, requestOrigin);
      if (url.origin !== requestOrigin) return json(res, 403, { error: '实例地址未登记' });
      if (matched.length && matched.every(entry => entry.probeOnly)
        && (req.method !== 'GET' || url.pathname !== '/auth/instance')) {
        return json(res, 403, { error: '实例地址未登记' });
      }
      const local = Boolean(localOrigin) && !funnel && !req.headers['x-forwarded-host'] && !req.headers.forwarded;
      // The device's update feed contains public packages and has no instance credentials.
      const origin = req.headers.origin;
      const releaseRequest = url.pathname === '/api/releases' || url.pathname.startsWith('/api/releases/');
      const localRelease = releaseRequest && local && (!origin || matchesOrigin(origin, requestOrigin)
        || (await remoteMappings()).some(entry => !entry.probeOnly && matchesOrigin(origin, entry.origin)));
      if (localRelease && await serveClientReleases(req, res, url, clientReleaseRoot, webRelease, { local, origin })) return;
      const game = games.find(game => requestOrigin === game.origin && url.pathname.startsWith(game.prefix));
      // The sandbox uses a bundle ticket instead of a instance session.
      if (game && url.pathname.startsWith(game.bundlePrefix)) return await game.serveFile(req, res, url);
      if (origin !== undefined && !matchesOrigin(origin, requestOrigin)) return json(res, 403, { error: '只接受同源工作台请求' });
      if (req.method === 'GET' && url.pathname === '/auth/instance') {
        const challenge = url.searchParams.get('challenge') || '';
        return /^[A-Za-z0-9_-]{43}$/.test(challenge) ? json(res, 200, { proof: instanceProof(accessToken, challenge) })
          : json(res, 400, { error: '无效的实例探测请求' });
      }
      if (url.pathname === '/sw.js' && ['GET', 'HEAD'].includes(req.method)) {
        // Old workers must be able to retire after their login expires. Host/Origin checks still apply.
        // This script only removes the offline shell; the next navigation uses the current login/page.
        const script = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('relay-shell-'))await caches.delete(name);await self.clients.claim();await self.registration.unregister();})()));`;
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
        res.end(req.method === 'HEAD' ? undefined : script); return;
      }
      const page = Boolean(game) || url.pathname === showcasePrefix || url.pathname === showcasePrefix.slice(0, -1);
      if (!authorize(req, res, url, requestOrigin, { page })) return;
      if (game) return await game.serveLauncher(req, res, url);
      if (url.pathname.startsWith(gamePrefix)) return json(res, 404, { error: '找不到已发布资源' });
      if (releaseRequest && await serveClientReleases(req, res, url, clientReleaseRoot, webRelease, { local })) return;
      if (url.pathname === showcasePrefix.slice(0, -1)) {
        res.writeHead(302, { Location: showcasePrefix }); res.end(); return;
      }
      if (url.pathname.startsWith(showcasePrefix)) {
        const name = url.pathname.slice(showcasePrefix.length) || 'index.html';
        const mime = showcaseMime.get(name.split('.').at(-1));
        if (!['GET', 'HEAD'].includes(req.method) || !mime || !/^(?:[A-Za-z0-9_-]+\.[A-Za-z0-9]+|assets\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)$/.test(name)) {
          res.writeHead(404); res.end('Not found'); return;
        }
        const content = await readFile(join(frontendRoot, 'avatar-showcase', name));
        res.writeHead(200, {
          'Content-Type': `${mime}${mime.startsWith('text/') ? '; charset=utf-8' : ''}`,
          'Content-Length': content.length, 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex',
        });
        res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return json(res, 405, { error: '不支持此方法' });
        const writes = !['GET', 'HEAD'].includes(req.method);
        const target = new URL(`${url.pathname}${url.search}`, upstream);
        const headers = { Authorization: `Bearer ${gatewayToken}`, Accept: req.headers.accept || '*/*' };
        if (typeof req.headers['x-summon-protocol'] === 'string') headers['X-Summon-Protocol'] = req.headers['x-summon-protocol'];
        if (typeof req.headers['x-summon-client-id'] === 'string') headers['X-Summon-Client-Id'] = req.headers['x-summon-client-id'];
        if (typeof req.headers['last-event-id'] === 'string') headers['Last-Event-ID'] = req.headers['last-event-id'];
        if (writes && req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
        if (writes && req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];
        const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers }, incoming => {
          const responseHeaders = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hopHeaders.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie'));
          // Preserve the upstream JSON/stream bytes through public proxies.
          // Browser failures must not silently leave an old cached sidebar.
          responseHeaders['Cache-Control'] = 'private, no-store, no-transform';
          responseHeaders['X-Content-Type-Options'] = 'nosniff';
          res.writeHead(incoming.statusCode || 502, responseHeaders);
          incoming.on('error', () => res.destroy());
          incoming.pipe(res);
        });
        active.add(outgoing);
        outgoing.once('close', () => active.delete(outgoing));
        outgoing.once('error', () => { if (!res.headersSent) json(res, 502, { error: '实例暂不可达' }); else res.destroy(); });
        if (url.pathname !== '/api/stream') outgoing.setTimeout(requestTimeoutMs, () => outgoing.destroy(new Error('Gateway request timed out')));
        req.once('error', error => outgoing.destroy(error));
        res.once('close', () => outgoing.destroy());
        if (writes) req.pipe(outgoing);
        else outgoing.end();
        return;
      }
      const entry = assets.get(url.pathname);
      if (!entry || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
      const [filename, mime] = entry;
      const asset = await readFile(join(frontendRoot, filename));
      const sprite = filename === 'index.html' ? await loadModelIconSprite() : '';
      const content = filename === 'index.html'
        ? Buffer.from(asset.toString('utf8').replace('<!-- MODEL_ICON_SPRITE -->', () => sprite))
        : asset;
      res.writeHead(200, { 'Content-Type': mime.startsWith('image/') ? mime : `${mime}; charset=utf-8`, 'Content-Length': content.length,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      if (!res.headersSent) json(res, 500, { error: '网页请求处理失败' }); else res.destroy();
    }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); });
  const address = server.address();
  return { url: `http://${host}:${address.port}`, server,
    async close() {
      closing = true;
      for (const request of active) request.destroy();
      await new Promise(accept => { server.close(accept); server.closeIdleConnections?.(); server.closeAllConnections?.(); });
    },
  };
}
