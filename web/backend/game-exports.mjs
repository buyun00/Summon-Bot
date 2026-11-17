import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { instanceOrigin } from './origins.mjs';

export const gamePrefix = '/api/games/';
const idPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; charset=utf-8)?$/i;
const headers = {
  'Cache-Control': 'private, no-store, no-transform',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

function safeSegment(value) {
  return value && !/[\x00-\x1f\x7f/\\:%<>?"|*]|[ .]$/.test(value) && !windowsDevice.test(value);
}

export async function openPublishedFile(path) {
  let file;
  try {
    // Include parent directories in the check because they can be junctions or symlinks too.
    if (relative(path, await realpath(path)) !== '') return;
    const entry = await lstat(path, { bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n) return;
    file = await open(path, 'r');
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== entry.dev || stat.ino !== entry.ino
      || relative(path, await realpath(path)) !== '') return;
    const result = { file, size: Number(stat.size) };
    file = undefined;
    return result;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  } finally { await file?.close(); }
}

function status(res, code) {
  res.writeHead(code, { ...headers, 'Content-Security-Policy': "sandbox; default-src 'none'",
    ...(code === 405 ? { Allow: 'GET, HEAD' } : {}) });
  res.end();
}

function fileType(manifest, name) {
  if (!name || name === 'manifest.json' || !name.split('/').every(safeSegment) || !manifest?.files
    || !Object.hasOwn(manifest.files, name)) return;
  const type = manifest.files[name];
  return typeof type === 'string' && !/[\r\n]/.test(type) && mediaType.test(type) ? type : undefined;
}

async function readManifest(root, version) {
  if (!idPattern.test(version || '') || !safeSegment(version)) return;
  const asset = await openPublishedFile(join(root, version, 'manifest.json'));
  if (!asset) return;
  try {
    const manifest = JSON.parse(await asset.file.readFile('utf8'));
    if (typeof manifest?.entry === 'string' && /^text\/html(?:;|$)/i.test(fileType(manifest, manifest.entry) || '')) return manifest;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn(`Invalid game manifest: ${version}`);
  } finally { await asset.file.close(); }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const urlPath = value => value.split('/').map(encodeURIComponent).join('/');

function createGame({ id, origin, root, title }, accessToken) {
  const prefix = `${gamePrefix}${id}/`;
  const bundlePrefix = `${prefix}_play/`;
  const sign = (version, expires) => createHmac('sha256', accessToken)
    .update(JSON.stringify(['summon-game-export', origin, id, version, expires])).digest('base64url');

  return {
    origin, prefix, bundlePrefix,
    async serveLauncher(req, res, url) {
      if (!['GET', 'HEAD'].includes(req.method)) return status(res, 405);
      if (req.url.split('?', 1)[0] !== url.pathname) return status(res, 404);
      const version = url.pathname.slice(prefix.length).replace(/\/$/, '');
      const manifest = await readManifest(root, version);
      if (!manifest) return status(res, 404);
      const asset = await openPublishedFile(join(root, version, manifest.entry));
      if (!asset) return status(res, 404);
      await asset.file.close();

      const minutes = Number.isSafeInteger(manifest.ticketMinutes) && manifest.ticketMinutes > 0
        ? Math.min(manifest.ticketMinutes, 30 * 24 * 60) : 30;
      const expires = String(Date.now() + minutes * 60_000);
      const launchPath = `${bundlePrefix}${version}/${expires}.${sign(version, expires)}/${urlPath(manifest.entry)}`;
      const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)} · ${escapeHtml(version)}</title>
<style>
html,body,iframe{width:100%;height:100%;margin:0;border:0}
body{background:#000;overflow:hidden}
iframe{display:block}
</style>
<iframe title="${escapeHtml(title)}" src="${escapeHtml(launchPath)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
</html>`;
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html),
        'Content-Security-Policy': `default-src 'none'; frame-src ${origin}${launchPath}; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
      res.end(req.method === 'HEAD' ? undefined : html);
    },

    async serveFile(req, res, url) {
      if (!['GET', 'HEAD'].includes(req.method)) return status(res, 405);
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== 'null' && requestOrigin !== origin) return status(res, 403);
      if (req.headers['service-worker'] === 'script') return status(res, 403);
      if (req.url.split('?', 1)[0] !== url.pathname) return status(res, 404);
      const [version, ticket, ...encodedParts] = url.pathname.slice(bundlePrefix.length).split('/');
      const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(ticket || '');
      if (!idPattern.test(version) || !safeSegment(version) || !match
        || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(version, match[1])))) return status(res, 404);
      if (req.headers['sec-fetch-dest'] === 'document') {
        res.writeHead(303, { ...headers, Location: `${prefix}${version}/` });
        res.end();
        return;
      }
      if (Number(match[1]) <= Date.now()) return status(res, 410);
      let parts;
      try { parts = encodedParts.map(decodeURIComponent); }
      catch { return status(res, 404); }
      if (!parts.every(safeSegment)) return status(res, 404);
      const manifest = await readManifest(root, version);
      const type = fileType(manifest, parts.join('/'));
      if (!type) return status(res, 404);
      const asset = await openPublishedFile(join(root, version, ...parts));
      if (!asset) return status(res, 404);

      try {
        const scope = `${origin}${bundlePrefix}${version}/${ticket}/`;
        const connect = Array.isArray(manifest.connectOrigins) ? manifest.connectOrigins.flatMap(value => {
          try { return [instanceOrigin(value, { httpsOnly: true })].filter(value => value !== origin); }
          catch { return []; }
        }) : [];
        const policy = [
          "sandbox allow-scripts", "default-src 'none'", `script-src ${scope} 'unsafe-inline' 'wasm-unsafe-eval'`,
          `style-src ${scope} 'unsafe-inline'`, ['connect-src', scope, ...connect].join(' '), `img-src ${scope} data: blob:`,
          `font-src ${scope}`, `media-src ${scope} blob:`,
          manifest.workers === true ? `worker-src ${scope} blob:` : "worker-src 'none'",
          `frame-ancestors ${origin}`, "base-uri 'none'", "form-action 'none'",
        ].join('; ');
        res.writeHead(200, {
          ...headers, 'Content-Type': type, 'Content-Length': asset.size, Vary: 'Origin',
          ...(requestOrigin === 'null' ? { 'Access-Control-Allow-Origin': 'null' } : {}),
          'Content-Security-Policy': policy,
        });
        if (req.method === 'HEAD') res.end();
        else await pipeline(asset.file.createReadStream(), res);
      } finally { await asset.file.close(); }
    },
  };
}

export function createGameExports(entries, accessToken) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => {
    try {
      const { id, root, title } = entry;
      if (typeof id !== 'string' || !idPattern.test(id) || typeof root !== 'string' || !isAbsolute(root)) return [];
      const origin = instanceOrigin(entry.origin);
      return [createGame({ id, root: resolve(root), origin, title: typeof title === 'string' ? title : id }, accessToken)];
    } catch { return []; }
  });
}
