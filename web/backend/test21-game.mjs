import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const origin = 'https://bot.lin0.org';
const prefix = '/api/games/test21/';
const bundlePrefix = `${prefix}_play/`;
const approvedRoot = 'D:/summontest/test21/publish/web';
const entry = 'index.html';
const versionName = /^v\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/;
const assetSegment = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const exportFiles = new Map([
  [entry, 'text/html; charset=utf-8'], ['index.js', 'text/javascript; charset=utf-8'],
  ['index.wasm', 'application/wasm'], ['index.wasm.gz', 'application/gzip'], ['index.pck', 'application/octet-stream'],
  ['index.audio.worklet.js', 'text/javascript; charset=utf-8'],
  ['index.audio.position.worklet.js', 'text/javascript; charset=utf-8'],
  ['index.png', 'image/png'], ['index.icon.png', 'image/png'], ['index.apple-touch-icon.png', 'image/png'],
  ['favicon.ico', 'image/x-icon'],
]);
const assetTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.woff2', 'font/woff2'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
  ['.ogg', 'audio/ogg'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'],
]);
const headers = {
  'Cache-Control': 'private, no-store, no-transform',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

function assetType(parts) {
  if (parts.length === 1) return exportFiles.get(parts[0]);
  if (parts[0] !== 'assets' || !parts.every(part => assetSegment.test(part) && !reservedName.test(part))) return;
  return assetTypes.get(extname(parts.at(-1)).toLowerCase());
}

async function openExportFile(path) {
  let file;
  try {
    // Resolve the whole path, including parent directories and Windows junctions.
    if (relative(path, await realpath(path)) !== '') return;
    const entryStat = await lstat(path, { bigint: true });
    if (!entryStat.isFile() || entryStat.nlink !== 1n) return;
    file = await open(path, 'r');
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== entryStat.dev || stat.ino !== entryStat.ino
      || relative(path, await realpath(path)) !== '') return;
    const result = { file, size: String(stat.size) };
    file = undefined;
    return result;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  } finally {
    await file?.close();
  }
}

function status(res, code) {
  res.writeHead(code, { ...headers, 'Content-Security-Policy': "sandbox; default-src 'none'",
    ...(code === 405 ? { Allow: 'GET, HEAD' } : {}) });
  res.end();
}

export function createTest21Game(configuredRoot) {
  if (typeof configuredRoot !== 'string' || !isAbsolute(configuredRoot) || relative(approvedRoot, configuredRoot) !== '') return;
  const root = resolve(approvedRoot);
  const key = randomBytes(32);
  const sign = (version, expires) => createHmac('sha256', key).update(`${version}/${expires}`).digest('base64url');
  const validTicket = (version, ticket) => {
    const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
    return match && Number(match[1]) > Date.now()
      && timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(version, match[1])));
  };

  return {
    origin, prefix, bundlePrefix,
    async serveLauncher(req, res, url) {
      if (!['GET', 'HEAD'].includes(req.method)) return status(res, 405);
      const version = url.pathname.slice(prefix.length).replace(/\/$/, '');
      if (!versionName.test(version) || req.url.split('?', 1)[0] !== url.pathname) return status(res, 404);
      const asset = await openExportFile(join(root, version, entry));
      if (!asset) return status(res, 404);
      await asset.file.close();

      const expires = Date.now() + 30 * 60 * 1000;
      const launchPath = `${bundlePrefix}${version}/${expires}.${sign(version, expires)}/${entry}`;
      const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>灯塔小冒险 · ${version}</title>
<style>
html,body,iframe{width:100%;height:100%;margin:0;border:0}
body{background:#000;overflow:hidden}
iframe{display:block}
</style>
<iframe title="灯塔小冒险" src="${launchPath}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
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
      const [version, ticket, ...parts] = url.pathname.slice(bundlePrefix.length).split('/');
      const mime = assetType(parts);
      if (!mime || !versionName.test(version) || !validTicket(version, ticket) || req.url.split('?', 1)[0] !== url.pathname) return status(res, 404);
      // Keep game code out of the Electron main frame, which receives the desktop preload bridge.
      if (req.headers['sec-fetch-dest'] === 'document') {
        res.writeHead(303, { ...headers, Location: `${prefix}${version}/` });
        res.end();
        return;
      }
      const asset = await openExportFile(join(root, version, ...parts));
      if (!asset) return status(res, 404);

      try {
        const scope = `${origin}${bundlePrefix}${version}/${ticket}/`;
        const policy = [
          "sandbox allow-scripts", "default-src 'none'", `script-src ${scope} 'unsafe-inline' 'wasm-unsafe-eval'`,
          `style-src ${scope} 'unsafe-inline'`, `connect-src ${scope}`, `img-src ${scope} data: blob:`,
          `font-src ${scope}`, `media-src ${scope} blob:`, "worker-src 'none'", `frame-ancestors ${origin}`,
          "base-uri 'none'", "form-action 'none'",
        ].join('; ');
        res.writeHead(200, {
          ...headers, 'Content-Type': mime, 'Content-Length': asset.size, Vary: 'Origin',
          ...(requestOrigin === 'null' ? { 'Access-Control-Allow-Origin': 'null' } : {}),
          'Content-Security-Policy': policy,
        });
        if (req.method === 'HEAD') res.end();
        else await pipeline(asset.file.createReadStream(), res);
      } finally {
        await asset.file.close();
      }
    },
  };
}
