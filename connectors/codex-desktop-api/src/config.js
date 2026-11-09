import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_ROOT = path.join(process.env.SUMMON_DATA_ROOT || (process.platform === 'win32' ? 'D:/Relay-Bot-data'
  : path.join(os.homedir(), 'Library', 'Application Support', 'Relay', 'workspace-data')), 'connectors', 'codex-desktop-api');
export const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
export function loadConfig(env = process.env) {
  const file = path.resolve(env.CODEX_DESKTOP_API_CONFIG || (env.SUMMON_DATA_ROOT
    ? path.join(env.SUMMON_DATA_ROOT, 'connectors', 'codex-desktop-api', 'config.json') : CONFIG_FILE));
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const config = {
    host: '127.0.0.1', port: 47831, connectTimeoutMs: 30000, requestTimeoutMs: 90000,
    acknowledgementTimeoutMs: 120000, mutationTimeoutMs: 900000, pollIntervalMs: 5000,
    discoveryLimit: 50, maxSubscriptions: 128, eventRetention: 10000,
    dataDir: path.dirname(file), callerThreadId: env.CODEX_THREAD_ID || null,
    ...saved,
    ...(env.CODEX_DESKTOP_API_HOST ? { host: env.CODEX_DESKTOP_API_HOST } : {}),
    ...(env.CODEX_DESKTOP_API_PORT ? { port: Number(env.CODEX_DESKTOP_API_PORT) } : {}),
    ...(env.CODEX_DESKTOP_API_CALLER_THREAD_ID ? { callerThreadId: env.CODEX_DESKTOP_API_CALLER_THREAD_ID } : {}),
  };
  for (const [key, min, max] of [['port', 1, 65535], ['connectTimeoutMs', 1000, 180000], ['requestTimeoutMs', 1000, 180000],
    ['acknowledgementTimeoutMs', 1000, 180000], ['mutationTimeoutMs', 1000, 1800000], ['pollIntervalMs', 1000, 60000],
    ['discoveryLimit', 1, 50], ['maxSubscriptions', 1, 1024], ['eventRetention', 100, 100000]]) {
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
