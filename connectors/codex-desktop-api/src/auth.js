import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
export const isLoopback = address => address === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address || '') || /^::ffff:127\.(?:\d{1,3}\.){2}\d{1,3}$/i.test(address || '');
export function requiresAuth(request, config) {
  const auth = config.auth || {};
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip'].some(key => request.headers[key] !== undefined);
  return !!(config.requireAuth || auth.requireAuth || auth.enabled || auth.localhostBypass === false || !isLoopback(request.socket.remoteAddress) || forwarded);
}
export function assertAuthorization(request, response, config) {
  if (!requiresAuth(request, config)) return;
  const token = config.auth?.bearerToken;
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(request.headers.authorization || '');
  const hash = value => createHash('sha256').update(value).digest();
  if (!token || !match || !timingSafeEqual(hash(token), hash(match[1]))) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="codex-desktop-api"');
    throw new ApiError(401, 'unauthorized', 'A valid Bearer token is required.');
  }
}
