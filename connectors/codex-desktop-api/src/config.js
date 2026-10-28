import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_ROOT = 'D:/Relay-Bot-data/connectors/codex-desktop-api';
export const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
export function loadConfig(env = process.env) {
  const file = path.resolve(env.CODEX_DESKTOP_API_CONFIG || CONFIG_FILE);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const config = {
    host: '127.0.0.1', port: 47831, requestTimeoutMs: 45000, pollIntervalMs: 5000,
    discoveryLimit: 50, maxSubscriptions: 128, eventRetention: 10000,
    dataDir: DATA_ROOT, callerThreadId: env.CODEX_THREAD_ID || null,
    ...saved,
    ...(env.CODEX_DESKTOP_API_HOST ? { host: env.CODEX_DESKTOP_API_HOST } : {}),
    ...(env.CODEX_DESKTOP_API_PORT ? { port: Number(env.CODEX_DESKTOP_API_PORT) } : {}),
    ...(env.CODEX_DESKTOP_API_CALLER_THREAD_ID ? { callerThreadId: env.CODEX_DESKTOP_API_CALLER_THREAD_ID } : {}),
  };
  for (const [key, min, max] of [['port', 1, 65535], ['requestTimeoutMs', 1000, 180000], ['pollIntervalMs', 1000, 60000], ['discoveryLimit', 1, 50], ['maxSubscriptions', 1, 1024], ['eventRetention', 100, 100000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid config ${key}: expected ${min}..${max}.`);
  }
  config.auth = { enabled: false, localhostBypass: true, ...saved.auth };
  for (const key of ['enabled', 'localhostBypass', 'requireAuth']) {
    if (config.auth[key] !== undefined && typeof config.auth[key] !== 'boolean') throw new Error('Invalid auth.' + key);
  }
  if (config.requireAuth !== undefined && typeof config.requireAuth !== 'boolean') throw new Error('Invalid requireAuth');
  if (config.auth.bearerToken !== undefined && (typeof config.auth.bearerToken !== 'string' || !/^[A-Za-z0-9._~+\/-]{32,}=*$/.test(config.auth.bearerToken))) throw new Error('auth.bearerToken must contain at least 32 token characters.');
  if ((config.requireAuth || config.auth.requireAuth || config.auth.enabled || !config.auth.localhostBypass || !['127.0.0.1', '::1', 'localhost'].includes(config.host)) && !config.auth.bearerToken) throw new Error('Authentication requires a token; run node scripts/token.js.');
  config.dataDir = path.resolve(ROOT, config.dataDir);
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host) && !config.allowRemote) throw new Error('Non-loopback bind requires allowRemote: true.');
  return config;
}
