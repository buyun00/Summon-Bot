import { readFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { normalizeLogConfig } from './process-log.mjs';

export function normalizeBotConfig(input, baseDirectory = process.cwd()) {
  if (!input || typeof input !== 'object') throw new TypeError('Bot configuration is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.botId || '')) throw new Error('Invalid botId');
  if (typeof input.dataDir !== 'string' || !input.dataDir) throw new Error('dataDir is required');
  if (!input.model || typeof input.model !== 'object' || !input.model.model || !input.model.baseUrl) throw new Error('Every Bot requires an explicit model {provider,model,baseUrl}');
  const endpoint = new URL(input.model.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid model baseUrl');
  const config = { schemaVersion: 1, ...input, dataDir: resolve(baseDirectory, input.dataDir) };
  config.instanceId = config.botId;
  config.workspace = resolve(baseDirectory, input.workspace || resolve(config.dataDir, 'workspace'));
  config.listen = { host: '127.0.0.1', port: 0, ...input.listen };
  if (!['127.0.0.1', '::1'].includes(config.listen.host) || !Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) throw new Error('Bot listener must use a valid loopback address');
  config.concurrency ??= 4;
  config.logs = normalizeLogConfig(input.logs);
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 32) throw new Error('Business concurrency must be 1..32');
  config.context = { maxSummaryTokens: 8192, maxAssemblyTokens: 6144, maintenanceConcurrency: 1, maintenanceDelayMs: 3000, ...input.context };
  for (const key of ['maxSummaryTokens', 'maxAssemblyTokens', 'maintenanceConcurrency', 'maintenanceDelayMs']) if (!Number.isSafeInteger(config.context[key]) || config.context[key] < 1) throw new Error(`Invalid context setting: ${key}`);
  config.shutdownGraceMs ??= 3000;
  if (!Number.isSafeInteger(config.shutdownGraceMs) || config.shutdownGraceMs < 0 || config.shutdownGraceMs > 60000) throw new Error('shutdownGraceMs must be 0..60000');
  if (config.token !== undefined && (typeof config.token !== 'string' || config.token.length < 24)) throw new Error('Bot management token must have at least 24 characters');
  config.skills = (input.skills || []).map(path => resolve(baseDirectory, path));
  config.promptPaths = (input.promptPaths || []).map(path => resolve(baseDirectory, path));
  if (config.promptFile) config.promptFile = resolve(baseDirectory, config.promptFile);
  config.tools = input.tools || [];
  if (config.catalog) {
    const catalogUrl = new URL(config.catalog.url);
    if (!['http:', 'https:'].includes(catalogUrl.protocol) || catalogUrl.username || catalogUrl.password || typeof config.catalog.token !== 'string' || config.catalog.token.length < 24) throw new Error('Catalog requires an explicit gateway URL and Bot capability token');
  }
  config.peers = input.peers || [];
  config.contacts = input.contacts || [];
  if (!Array.isArray(config.contacts) || !Array.isArray(config.peers)) throw new Error('contacts and peers must be arrays');
  for (const contact of config.contacts) {
    if (!contact.botId || contact.botId === config.botId || typeof contact.token !== 'string' || contact.token.length < 24) throw new Error('Contact requires a different botId and private token');
    if (contact.dataDir !== undefined) { if (typeof contact.dataDir !== 'string' || !isAbsolute(contact.dataDir)) throw new Error('Local contact requires an absolute dataDir'); }
    else { const url = new URL(contact.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid contact URL'); }
  }
  if (new Set(config.contacts.map(contact => contact.botId)).size !== config.contacts.length) throw new Error('Contact IDs must be unique');
  for (const peer of config.peers) if (!peer.botId || typeof peer.token !== 'string' || peer.token.length < 24) throw new Error('Peer requires botId and private token');
  if (new Set(config.peers.map(peer => peer.token)).size !== config.peers.length) throw new Error('Peer authentication tokens must be unique');
  if (new Set(config.peers.map(peer => peer.botId)).size !== config.peers.length || config.peers.some(peer => peer.botId === config.botId || peer.token === config.token)) throw new Error('Invalid peer identity or management token reuse');
  config.model = { provider: 'openai-compatible', contextWindow: 1048576, maxTokens: 393216, ...input.model };
  config.limits = { ...input.limits };
  for (const key of Object.keys(config.limits)) if (!['reserveTokens', 'keepRecentTokens'].includes(key)) throw new Error(`Unsupported limits setting: ${key}`);
  if (config.app !== undefined || config.appFactory !== undefined) throw new Error('Bot always uses its Pi Agent; custom application factories are unsupported');
  return config;
}

export function loadBotConfig(path) {
  const absolute = resolve(path);
  return normalizeBotConfig(JSON.parse(readFileSync(absolute, 'utf8')), dirname(absolute));
}

export function createRedactor(config) {
  const secrets = new Set();
  const visit = (value, key = '') => {
    if (typeof value === 'string' && /token|apiKey|authorization|password|secret/i.test(key) && value.length >= 8) secrets.add(value);
    else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'headersEnv' && child && typeof child === 'object') for (const name of Object.values(child)) if (process.env[name]) secrets.add(process.env[name]);
      if (childKey === 'env' && typeof child === 'string' && process.env[child]) secrets.add(process.env[child]);
      visit(child, childKey);
    }
  };
  visit(config);
  if (config.model.apiKeyEnv && process.env[config.model.apiKeyEnv]) secrets.add(process.env[config.model.apiKeyEnv]);
  return value => {
    if (value === undefined) return undefined;
    let text = JSON.stringify(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return JSON.parse(text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]'));
  };
}
