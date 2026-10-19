import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    result[match[1]] = value;
  }
  return result;
}

function readEnv(path) {
  try { return parseEnv(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function loadConfig(overrides = {}) {
  const local = readEnv(join(projectRoot, '.env'));
  const env = { ...local, ...process.env };
  const hermesHome = env.HERMES_HOME || join(homedir(), 'AppData', 'Local', 'hermes');
  const hermes = readEnv(join(hermesHome, '.env'));
  let apiKey = env.DEEPSEEK_API_KEY?.trim();
  let credentialSource = apiKey ? (process.env.DEEPSEEK_API_KEY ? 'environment' : 'local .env') : 'missing';
  if (!apiKey && hermes.DEEPSEEK_API_KEY?.trim()) {
    apiKey = hermes.DEEPSEEK_API_KEY.trim();
    credentialSource = 'existing Hermes .env';
  }
  if (!apiKey) {
    const source = join(homedir(), 'Documents', 'ds.txt');
    if (existsSync(source)) {
      apiKey = readFileSync(source, 'utf8').match(/\bsk-[a-zA-Z0-9_-]+\b/)?.[0];
      if (apiKey) credentialSource = 'existing ds.txt';
    }
  }
  const dataDir = resolve(env.RELAY_DATA_DIR || join(projectRoot, '.relay'));
  const config = {
    root: projectRoot, host: '127.0.0.1', port: Number(env.RELAY_PORT || 8787),
    dataDir, database: join(dataDir, 'relay.sqlite'),
    defaultCwd: resolve(env.RELAY_WORKSPACE || projectRoot),
    apiKey: apiKey || '', credentialSource,
    baseUrl: (env.DEEPSEEK_BASE_URL || hermes.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    model: 'deepseek-flash', codexPath: env.CODEX_BIN || undefined,
    ...overrides,
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('RELAY_PORT 必须是 0–65535 的整数');
  mkdirSync(config.dataDir, { recursive: true });
  return config;
}

export function safeError(error, config) {
  let text = error instanceof Error ? error.message : String(error);
  if (config?.apiKey) text = text.split(config.apiKey).join('[redacted]');
  return text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]').slice(0, 1200);
}
