import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './errors.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/console', ['index.html', 'text/html; charset=utf-8']],
  ['/console/', ['index.html', 'text/html; charset=utf-8']],
  ['/console/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/console/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/console/model.js', ['model.js', 'text/javascript; charset=utf-8']],
  ['/console/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
export function serveConsole(request, response, url, openapi) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const asset = assets.get(url.pathname);
  if (!asset && url.pathname !== '/console/schema.json') return false;
  const content = asset ? fs.readFileSync(path.join(webRoot, asset[0])) : Buffer.from(JSON.stringify(openapi));
  response.writeHead(200, {
    'Content-Type': asset ? asset[1] : 'application/json; charset=utf-8',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(request.method === 'HEAD' ? undefined : content);
  return true;
}

export function assertBrowserOrigin(request, config) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new ApiError(403, 'browser_origin_disabled', 'Invalid browser origin.'); }
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', config.host].filter(Boolean));
  const expected = `http://${request.headers.host}`;
  if (parsed.origin !== expected || !allowedHosts.has(parsed.hostname) || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new ApiError(403, 'browser_origin_disabled', 'Only the API testing page on this same origin may make browser requests.');
  }
}
