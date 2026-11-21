import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, open, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

export const connectionPath = dataRoot => join(resolve(dataRoot), 'config', 'model-connections.json');
export const localCodexAuthPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
export const localGrokAuthPath = () => process.env.GROK_AUTH_PATH || join(process.env.GROK_HOME || join(homedir(), '.grok'), 'auth.json');
export function grokProxyHeaders(connection = {}) {
  // Grok's proxy gates clients by wire version. Prefer the installed CLI's version;
  // the bundled protocol baseline follows x.ai/cli/stable when this adapter is updated.
  let version = '1.0.70';
  try { const local = JSON.parse(readFileSync(join(dirname(connection.authFile || localGrokAuthPath()), 'version.json'), 'utf8')).version;
    if (typeof local === 'string' && /^\d+\.\d+\.\d+$/.test(local)) version = local;
  } catch {}
  return { 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response',
    'x-grok-client-version': version, 'x-grok-client-mode': 'headless', 'x-grok-client-identifier': 'summon-bot',
    ...(connection.model ? { 'x-grok-model-override': connection.model } : {}) };
}
const factories = { codex: openaiCodexProvider, grok: xaiProvider, deepseek: deepseekProvider, openai: openaiProvider, anthropic: anthropicProvider, xai: xaiProvider };
const apis = { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi,
  'openai-codex-responses': openAICodexResponsesApi, 'anthropic-messages': anthropicMessagesApi };
const openAIExplicitCacheModels = new Set([
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna',
  'gpt-6.2-sol', 'gpt-6.2-astra',
]);
// The direct API window includes input and output. The bundled Responses
// catalog reports 272K for these entries and omits newer 6.1/6.2 entries.
const openAILongContextModels = new Set(['gpt-5.4', 'gpt-5.5', ...openAIExplicitCacheModels]);
const openAILongContextBudget = { contextWindow: 1050000, maxTokens: 128000 };
const terraThinkingMap = Object.freeze({ off: 'none', minimal: null, low: 'low', medium: null, high: 'high', max: 'max' });
const solAstraOpenAIMap = Object.freeze({ off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
const solAstraCodexMap = Object.freeze({ off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
// Pi emits strict:false for ordinary function tools when the Responses endpoint supports the flag.
const openAISupplementalModels = Object.freeze([
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', api: 'openai-responses', type: 'chat', reasoning: true, input: ['text', 'image'],
    contextWindow: openAILongContextBudget.contextWindow, maxTokens: openAILongContextBudget.maxTokens,
    thinkingLevelMap: terraThinkingMap, compat: { supportsStrictMode: true, supportsExplicitPromptCacheMode: true } },
  { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', api: 'openai-responses', type: 'chat', reasoning: true, input: ['text', 'image'],
    contextWindow: openAILongContextBudget.contextWindow, maxTokens: openAILongContextBudget.maxTokens,
    thinkingLevelMap: solAstraOpenAIMap, compat: { supportsStrictMode: true, supportsExplicitPromptCacheMode: true } },
  { id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', api: 'openai-responses', type: 'chat', reasoning: true, input: ['text', 'image'],
    contextWindow: openAILongContextBudget.contextWindow, maxTokens: openAILongContextBudget.maxTokens,
    thinkingLevelMap: solAstraOpenAIMap, compat: { supportsStrictMode: true, supportsExplicitPromptCacheMode: true } },
]);
const codexSupplementalModels = Object.freeze([
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', api: 'openai-codex-responses', type: 'chat', reasoning: true, input: ['text', 'image'],
    contextWindow: 500000, maxTokens: 128000, thinkingLevelMap: terraThinkingMap,
    compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true } },
  { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', api: 'openai-codex-responses', type: 'chat', reasoning: true, input: ['text', 'image'],
    contextWindow: 500000, maxTokens: 128000, thinkingLevelMap: solAstraCodexMap,
    compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true } },
  { id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', api: 'openai-codex-responses', type: 'chat', reasoning: true, input: ['text', 'image'],
    contextWindow: 500000, maxTokens: 128000, thinkingLevelMap: solAstraCodexMap,
    compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true } },
]);

export const modelPurposes = Object.freeze(['fast_read', 'conversation', 'pi_session']);
export const purposeTemplateCategories = Object.freeze(['deepseek', 'openai', 'codex']);
export function defaultPurposeDefaults() {
  return {
    deepseek: {
      fast_read: { model: 'deepseek-flash', thinking_level: 'off' },
      conversation: { model: 'deepseek-flash', thinking_level: 'high' },
      pi_session: { model: 'deepseek-flash', thinking_level: 'max' },
    },
    openai: {
      fast_read: { model: 'gpt-6.1-terra', thinking_level: 'off' },
      conversation: { model: 'gpt-6.1-terra', thinking_level: 'high' },
      pi_session: { model: 'gpt-6.2-sol', thinking_level: 'high' },
    },
    codex: {
      fast_read: { model: 'gpt-6.1-terra', thinking_level: 'off' },
      conversation: { model: 'gpt-6.1-terra', thinking_level: 'high' },
      pi_session: { model: 'gpt-6.2-sol', thinking_level: 'high' },
    },
  };
}
export function defaultCodexRecommendations() {
  return [
    { model: 'gpt-6.2-sol', efforts: ['xhigh', 'max'] },
    { model: 'gpt-6.2-astra', efforts: ['high', 'xhigh', 'max'] },
  ];
}
export function purposeCategory(connection) {
  if (!connection) return null;
  if (connection.kind === 'codex') return 'codex';
  if (connection.kind === 'api' && connection.provider === 'deepseek') return 'deepseek';
  if (connection.kind === 'api' && connection.provider === 'openai' && (connection.api || 'openai-responses') === 'openai-responses') return 'openai';
  return null;
}
export function templateProbeConnection(category) {
  if (category === 'deepseek') return { id: 'template-deepseek', name: 'DeepSeek API', kind: 'api', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
  if (category === 'openai') return { id: 'template-openai', name: 'OpenAI API', kind: 'api', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra' };
  if (category === 'codex') return { id: 'template-codex', name: 'Codex 订阅', kind: 'codex', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', model: 'gpt-6.1-terra' };
  return null;
}
export function normalizeModelCatalog(catalog) {
  const defaults = defaultPurposeDefaults();
  const savedDefaults = catalog?.purposeDefaults && typeof catalog.purposeDefaults === 'object' ? catalog.purposeDefaults : {};
  const purposeDefaults = {};
  for (const category of purposeTemplateCategories) {
    purposeDefaults[category] = {};
    for (const purpose of modelPurposes) {
      const entry = savedDefaults[category]?.[purpose];
      purposeDefaults[category][purpose] = entry?.model
        ? { model: String(entry.model).trim(), thinking_level: entry.thinking_level ?? null }
        : { ...defaults[category][purpose] };
    }
  }
  const connectionPurposes = catalog?.connectionPurposes && typeof catalog.connectionPurposes === 'object' && !Array.isArray(catalog.connectionPurposes)
    ? structuredClone(catalog.connectionPurposes) : {};
  const savedCodex = catalog?.externalEngines?.codex?.recommended;
  const recommended = Array.isArray(savedCodex) && savedCodex.length
    ? savedCodex.filter(item => typeof item?.model === 'string' && item.model.trim() && Array.isArray(item.efforts) && item.efforts.length)
      .map(item => ({ model: item.model.trim(), efforts: [...new Set(item.efforts.map(e => String(e).trim()).filter(Boolean))] }))
    : defaultCodexRecommendations();
  const { fastId, ...rest } = catalog;
  return {
    ...rest,
    schemaVersion: 2,
    autoGrantPurposeConnections: catalog?.autoGrantPurposeConnections !== false,
    purposeDefaults,
    connectionPurposes,
    externalEngines: { ...(catalog?.externalEngines && typeof catalog.externalEngines === 'object' ? catalog.externalEngines : {}),
      codex: { recommended: recommended.length ? recommended : defaultCodexRecommendations() } },
  };
}
export function readConnectionCatalog(path) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog?.connections)) throw new Error('The model connections catalog is unavailable');
  return normalizeModelCatalog(catalog);
}
async function retryFileOperation(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await delay(Math.min(25 * 2 ** attempt, 400));
    }
  }
}

export async function saveModelJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2)); } finally { await handle.close(); }
    await retryFileOperation(() => rename(temporary, path));
  } catch (error) {
    await retryFileOperation(() => unlink(temporary)).catch(cleanup => { if (cleanup.code !== 'ENOENT') error.cause = cleanup; });
    throw error;
  }
}
export function modelConnection(config, id) {
  if (!config.connectionStore) return { kind: 'api', id: config.provider || 'api', ...config };
  const catalog = readConnectionCatalog(config.connectionStore);
  const selected = catalog.connections.find(item => item.id === (id || catalog.activeId));
  if (!selected) throw new Error('请先在模型与引擎设置中选择聊天模型');
  return { ...selected, connectionStore: config.connectionStore, environmentFile: selected.environmentFile ?? catalog.environmentFile };
}
export function officialDeepSeekCompletions(connection, api, baseUrl) {
  return connection.kind === 'api' && connection.provider === 'deepseek' && api === 'openai-completions' &&
    Boolean(baseUrl) && new URL(baseUrl).hostname === 'api.deepseek.com' &&
    ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(connection.model);
}
export function terraResponses(connection, api, model = connection.model) {
  return (connection.kind === 'codex' && api === 'openai-codex-responses' ||
    connection.kind === 'api' && connection.provider === 'openai' && api === 'openai-responses') && model === 'gpt-6.1-terra';
}
export function supportsOpenAIRoomCache(connection, model) {
  return connection.kind === 'api' && connection.provider === 'openai' && model.api === 'openai-responses' &&
    model.baseUrl?.replace(/\/+$/, '') === 'https://api.openai.com/v1' &&
    (model.compat?.supportsExplicitPromptCacheMode === true || openAIExplicitCacheModels.has(model.id));
}
export function connectionModel(connection) {
  const native = factories[connection.kind === 'api' ? connection.provider : connection.kind]?.();
  const api = connection.kind === 'codex' ? 'openai-codex-responses' : connection.kind === 'grok' ? 'openai-responses' : connection.api || 'openai-completions';
  const baseUrl = connection.kind === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : connection.baseUrl || native?.baseUrl;
  const deepseek = officialDeepSeekCompletions(connection, api, baseUrl);
  const directOpenAI = connection.kind === 'api' && connection.provider === 'openai' && api === 'openai-responses' &&
    baseUrl?.replace(/\/+$/, '') === 'https://api.openai.com/v1' && openAILongContextModels.has(connection.model);
  const supplemental = connection.kind === 'codex' ? codexSupplementalModels
    : connection.kind === 'api' && connection.provider === 'openai' && api === 'openai-responses' ? openAISupplementalModels : [];
  const known = native?.getModels().find(model => model.api === api &&
    (model.id === connection.model || deepseek && model.id === 'deepseek-flash' && connection.model.startsWith('deepseek-v4-flash'))) ||
    supplemental.find(model => model.api === api && model.id === connection.model);
  // The official Completions schema gives exact powers of two. Pi's bundled
  // DeepSeek catalog uses the rounded marketing figures and sends a limit.
  const nativeWindow = deepseek ? 1048576 : directOpenAI ? openAILongContextBudget.contextWindow : known?.contextWindow;
  const nativeOutput = deepseek ? 393216 : directOpenAI ? openAILongContextBudget.maxTokens : known?.maxTokens;
  const context = Number(connection.contextWindow ?? (nativeWindow || 128000));
  const customOutput = connection.maxTokens == null ? null : Number(connection.maxTokens);
  const contextWindow = context;
  if (!Number.isSafeInteger(context) || context < 4096 || customOutput !== null &&
    (!Number.isSafeInteger(customOutput) || customOutput < 128 || customOutput >= context)) throw new Error('模型上下文与输出上限设置不正确');
  const thinking = connection.thinkingLevel ?? null;
  const nativeDefault = deepseek ? (thinking === 'off' ? 8192 : thinking === 'max' ? 131072 : 65536) : nativeOutput || 8192;
  const outputTokenLimit = Math.min(customOutput ?? nativeOutput ?? nativeDefault, contextWindow - 1);
  const maxTokens = Math.min(customOutput ?? nativeDefault, outputTokenLimit);
  const budgetSource = { contextWindow: connection.contextWindow != null ? 'configured' : nativeWindow ? 'catalog' : 'default',
    maxTokens: customOutput != null ? 'configured' : nativeOutput ? 'catalog' : 'default' };
  const resolvedThinkingMap = known?.thinkingLevelMap ?? (terraResponses(connection, api) ? terraThinkingMap : undefined);
  const probe = known ? { ...known, ...(resolvedThinkingMap ? { thinkingLevelMap: resolvedThinkingMap } : {}) } : null;
  return { ...known, id: connection.model, name: known?.name || connection.model, type: 'chat', api,
    provider: connection.id || connection.provider, baseUrl,
    ...(connection.kind === 'grok' ? { headers: { ...known?.headers, ...grokProxyHeaders(connection) } } : {}),
    reasoning: connection.reasoning !== false, input: known && known.id === connection.model ? known.input ?? ['text'] : ['text'], contextWindow, maxTokens, outputTokenLimit, budgetSource,
    thinkingLevels: probe?.reasoning !== undefined ? getSupportedThinkingLevels(probe) : undefined,
    ...(resolvedThinkingMap ? { thinkingLevelMap: resolvedThinkingMap } : {}),
    cost: connection.kind === 'api' ? known?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(api === 'openai-completions' && !known ? { compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: 'max_tokens' } } : {}) };
}
export function validateModelPurpose(connection, modelId, thinkingLevel, field = 'thinking_level') {
  const effective = connectionModel({ ...connection, model: modelId, thinkingLevel: thinkingLevel ?? null });
  if (thinkingLevel !== null && thinkingLevel !== undefined) {
    if (Array.isArray(effective.thinkingLevels) && !effective.thinkingLevels.includes(thinkingLevel)) {
      const message = `${field} · 模型 ${modelId}（${connection.name || connection.id}）不支持思考档 ${thinkingLevel}，可用档位：${effective.thinkingLevels.join(' / ')}`;
      throw Object.assign(new Error(message), { status: 400, code: 'invalid_thinking_level',
        details: { field, model: modelId, thinking_level: thinkingLevel, allowed: effective.thinkingLevels } });
    }
  }
  return effective;
}
export function resolveConnectionPurpose(catalog, connectionId, purpose = 'conversation', visited = new Set()) {
  const normalized = normalizeModelCatalog(catalog);
  const entry = normalized.connections.find(item => item.id === connectionId);
  if (!entry) return null;
  const override = !visited.has(connectionId) ? normalized.connectionPurposes?.[connectionId]?.[purpose] : null;
  if (override && (override.model || override.connection_id || override.thinking_level !== undefined)) {
    const targetId = override.connection_id || connectionId;
    const target = normalized.connections.find(item => item.id === targetId);
    if (!target) return null;
    if (override.model) {
      return { connection_id: target.id, id: override.model, thinking_level: override.thinking_level ?? null, source: 'connection_override' };
    }
    const nextVisited = new Set(visited);
    nextVisited.add(connectionId);
    const base = resolveConnectionPurpose(normalized, target.id, purpose, nextVisited);
    return base ? { ...base, thinking_level: override.thinking_level !== undefined ? override.thinking_level : base.thinking_level, source: 'connection_override' } : null;
  }
  const category = purposeCategory(entry);
  const template = category && normalized.purposeDefaults?.[category]?.[purpose];
  if (template?.model) {
    return { connection_id: entry.id, id: template.model, thinking_level: template.thinking_level ?? null, source: `template:${category}` };
  }
  const fallback = connectionModel(entry);
  let thinking = entry.thinkingLevel ?? null;
  if (purpose === 'fast_read' && fallback.thinkingLevels?.includes('off')) thinking = 'off';
  else if (purpose === 'pi_session' && fallback.thinkingLevels?.includes('high')) thinking = 'high';
  return { connection_id: entry.id, id: entry.model, thinking_level: thinking, source: 'connection_default' };
}
export function resolveBotModelSelection(catalog, botModel, purpose = 'conversation') {
  if (!botModel) return null;
  const normalized = normalizeModelCatalog(catalog);
  if (botModel.mode === 'follow_default') {
    return normalized.activeId ? resolveConnectionPurpose(normalized, normalized.activeId, purpose) : null;
  }
  if (botModel.mode === 'follow_connection') {
    return botModel.connection_id ? resolveConnectionPurpose(normalized, botModel.connection_id, purpose) : null;
  }
  const override = botModel.purposes?.[purpose];
  if (override && (override.connection_id || override.id || override.thinking_level !== undefined)) {
    const connId = override.connection_id || botModel.connection_id;
    if (!connId) return null;
    const base = resolveConnectionPurpose(normalized, connId, purpose);
    const id = override.id || (override.connection_id ? base?.id : (botModel.id || base?.id));
    if (!id) return null;
    const thinking_level = override.thinking_level !== undefined ? override.thinking_level
      : override.id ? null : (override.connection_id ? (base?.thinking_level ?? null) : (botModel.thinking_level ?? base?.thinking_level ?? null));
    return { connection_id: connId, id, thinking_level, source: 'bot_purpose_override' };
  }
  if (!botModel.connection_id) return null;
  const entry = normalized.connections.find(item => item.id === botModel.connection_id);
  if (!entry) return { connection_id: botModel.connection_id, id: botModel.id || '', thinking_level: botModel.thinking_level ?? null, source: 'bot_custom' };
  if (botModel.id) {
    let thinking = botModel.thinking_level ?? entry.thinkingLevel ?? null;
    if (purpose === 'fast_read') {
      const effective = connectionModel({ ...entry, model: botModel.id });
      if (effective.thinkingLevels?.includes('off')) thinking = 'off';
    }
    return { connection_id: botModel.connection_id, id: botModel.id, thinking_level: thinking, source: 'bot_custom' };
  }
  const base = resolveConnectionPurpose(normalized, botModel.connection_id, purpose);
  return base ? { ...base, thinking_level: botModel.thinking_level !== undefined && botModel.thinking_level !== null ? botModel.thinking_level : base.thinking_level, source: 'bot_custom' } : null;
}
export function modelChoices(kind, provider) {
  const models = factories[kind === 'api' ? provider : kind]?.().getModels() || [];
  const supplemental = kind === 'codex' ? codexSupplementalModels : kind === 'api' && provider === 'openai' ? openAISupplementalModels : [];
  const catalog = [...models];
  for (const extra of supplemental) {
    if (!catalog.some(model => model.id === extra.id && model.api === extra.api)) catalog.push(extra);
  }
  return catalog.map(model => {
    const budget = connectionModel({ kind, provider, model: model.id, api: model.api });
    return { id: model.id, name: model.name, contextWindow: budget.contextWindow, maxTokens: budget.outputTokenLimit,
      api: model.api, thinkingLevels: budget.thinkingLevels };
  });
}
export function decodeModelToken(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}
export function codexCredential(value) {
  const tokens = value?.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) throw new Error('本机 Codex 尚未使用 ChatGPT 订阅登录，请先在 Codex 中登录');
  const claims = decodeModelToken(tokens.access_token), accountId = tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId) throw new Error('本机 Codex 登录信息缺少订阅账号，请重新登录 Codex');
  return { type: 'oauth', access: tokens.access_token, refresh: tokens.refresh_token,
    expires: typeof claims.exp === 'number' ? claims.exp * 1000 - 60000 : 0, accountId };
}
// Grok Build stores a map of issuer scopes, not the Codex token format.
export function localGrokLogin(value, scope) {
  const candidates = Object.entries(value || {}).filter(([key, entry]) => (!scope || key === scope)
    && entry && typeof entry.key === 'string' && entry.key && entry.auth_mode !== 'api_key'
    && entry.oidc_issuer === 'https://auth.x.ai');
  candidates.sort((a, b) => String(b[1].create_time || '').localeCompare(String(a[1].create_time || '')));
  const [authScope, entry] = candidates[0] || [];
  if (!entry) throw new Error('没有找到可导入的 Grok 订阅登录，请在 Grok 中登录，或使用订阅授权');
  const claims = decodeModelToken(entry.key);
  const expiresAt = entry.expires_at ? Date.parse(entry.expires_at) : typeof claims.exp === 'number' ? claims.exp * 1000 : Date.parse(entry.create_time) + 30 * 86400000;
  const refreshable = typeof entry.refresh_token === 'string' && entry.refresh_token && typeof entry.oidc_client_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(entry.oidc_client_id);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() && !refreshable) throw new Error('本机 Grok 登录已过期，请重新登录或使用订阅授权');
  return { authScope, identity: typeof entry.email === 'string' ? entry.email : '本机 Grok 账号', credential: {
    type: 'oauth', access: entry.key, refresh: refreshable ? entry.refresh_token : '', expires: expiresAt - 60000,
    clientId: refreshable ? entry.oidc_client_id : null } };
}
async function refreshLocalGrok(credential, signal) {
  if (!credential.refresh || !credential.clientId) throw new Error('请在 Grok 中重新登录，然后再次导入');
  const response = await fetch('https://auth.x.ai/oauth2/token', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: credential.clientId }) });
  if (!response.ok) throw new Error(`本机 Grok 登录刷新失败（HTTP ${response.status}），请重新登录或改用订阅授权`);
  const result = await response.json();
  if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('Grok 未返回有效的登录信息，请重新授权');
  return { ...credential, access: result.access_token, refresh: result.refresh_token || credential.refresh, expires: Date.now() + result.expires_in * 1000 - 60000 };
}
async function readLocalModelAuth(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('无法读取本机模型登录，请重新登录或使用订阅授权'); }
}
function envValue(name, file) {
  if (!name) return undefined;
  if (process.env[name]) return process.env[name];
  if (!file || !existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match?.[1] === name) return match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
async function fileLock(path, action, signal) {
  const lock = `${path}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const ownerPath = join(lock, 'owner');
  const waitUntil = Date.now() + 15000;
  while (true) {
    signal?.throwIfAborted();
    if (Date.now() >= waitUntil) throw Object.assign(new Error('The model credential store is busy'), { code: 'credential_store_busy', status: 503 });
    try { await mkdir(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(ownerPath, 'utf8').catch(() => '0'));
      if (Number.isSafeInteger(owner) && owner > 0 && owner <= 0x7fffffff) {
        try { process.kill(owner, 0); }
        catch (failure) {
          if (failure.code === 'ESRCH' && Number(await readFile(ownerPath, 'utf8').catch(() => '0')) === owner) {
            const removed = await unlink(ownerPath).then(() => true, () => false);
            if (removed) await rmdir(lock).catch(() => {});
          }
        }
      }
      await delay(60, undefined, { signal });
      continue;
    }
    try { await writeFile(ownerPath, String(process.pid)); }
    catch (error) { await rmdir(lock).catch(() => {}); throw error; }
    break;
  }
  try { return await action(); }
  finally { await unlink(ownerPath); await rmdir(lock); }
}
/** Credentials stay on the host. Local logins are referenced; removing a Summon connection does not log out the CLI. */
export class ModelCredentialStore {
  constructor(path, fallback) { this.catalogPath = path; this.path = path ? join(dirname(path), 'model-credentials.json') : null; this.fallback = fallback; this.memory = new Map(); }
  connection(id) { return this.catalogPath ? modelConnection({ connectionStore: this.catalogPath }, id) : this.fallback; }
  async saved() {
    if (!this.path) return Object.fromEntries(this.memory);
    try {
      const credentials = JSON.parse(await readFile(this.path, 'utf8'));
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Model credentials are unavailable');
      return credentials;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async read(id) {
    const connection = this.connection(id);
    if (connection.authMode === 'codex-local') return codexCredential(await readLocalModelAuth(connection.authFile));
    if (connection.authMode === 'grok-local') return localGrokLogin(await readLocalModelAuth(connection.authFile), connection.authScope).credential;
    const stored = (await this.saved())[connection.credentialId ?? id];
    if (stored) return stored;
    const key = connection.apiKey || envValue(connection.apiKeyEnv, connection.environmentFile);
    return key ? { type: 'api_key', key } : undefined;
  }
  async list() {
    const connections = this.catalogPath ? readConnectionCatalog(this.catalogPath).connections : [this.fallback];
    const output = [];
    for (const connection of connections) try { const value = await this.read(connection.id); if (value) output.push({ providerId: connection.id, type: value.type }); } catch {}
    return output;
  }
  async modify(id, fn, options = {}) {
    const update = async () => {
      const connection = this.connection(id), current = await this.read(id), next = await fn(current);
      if (!next || next === current) return current;
      if (connection.authMode === 'codex-local') {
        const latest = await readLocalModelAuth(connection.authFile);
        // A concurrently refreshed desktop login owns its newer credential.
        if (latest.tokens?.refresh_token !== current?.refresh) return codexCredential(latest);
        await writeFile(connection.authFile, JSON.stringify({ ...latest, tokens: { ...latest.tokens,
          access_token: next.access, refresh_token: next.refresh, account_id: next.accountId || latest.tokens.account_id }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
      } else if (connection.authMode === 'grok-local') {
        const latest = await readLocalModelAuth(connection.authFile);
        const entry = latest[connection.authScope], login = localGrokLogin(latest, connection.authScope);
        if (login.credential.refresh !== current?.refresh || login.credential.access !== current?.access) return login.credential;
        await saveModelJson(connection.authFile, { ...latest, [connection.authScope]: { ...entry,
          key: next.access, refresh_token: next.refresh, expires_at: new Date(next.expires + 60000).toISOString(), create_time: new Date().toISOString() } });
      } else if (this.path) await saveModelJson(this.path, { ...await this.saved(), [connection.credentialId ?? id]: next });
      else this.memory.set(id, next);
      return next;
    };
    return this.path ? fileLock(this.path, update, options.signal) : update();
  }
  async delete(id, options = {}) {
    if (!this.path) { this.memory.delete(id); return; }
    await fileLock(this.path, async () => {
      const key = this.connection(id).credentialId ?? id;
      const values = await this.saved();
      if (Object.hasOwn(values, key)) { delete values[key]; await saveModelJson(this.path, values); }
    }, options.signal);
  }
  async prune(catalog, values) {
    const retained = new Set(catalog.connections.map(entry => entry.credentialId ?? entry.id));
    if (Object.keys(values).every(key => retained.has(key))) return values;
    const next = Object.fromEntries(Object.entries(values).filter(([key]) => retained.has(key)));
    await saveModelJson(this.path, next);
    return next;
  }
  pruneUnreferenced() {
    return fileLock(this.path, async () => { await this.prune(readConnectionCatalog(this.catalogPath), await this.saved()); });
  }
  updateCatalog(change, newKey, deferCleanup) {
    return fileLock(this.path, async () => {
      const catalog = readConnectionCatalog(this.catalogPath);
      // Clean up interrupted changes before a removed connection ID can be reused.
      let values = await this.prune(catalog, await this.saved());
      await change(catalog);
      if (newKey) {
        const entry = catalog.connections.find(item => item.id === newKey.id);
        entry.credentialId = `key/${randomUUID()}`;
        delete entry.apiKeyEnv;
        values = { ...values, [entry.credentialId]: { type: 'api_key', key: newKey.key } };
        await saveModelJson(this.path, values);
      }
      try {
        // This atomic rename publishes the complete connection and its already-staged credential.
        await saveModelJson(this.catalogPath, normalizeModelCatalog(catalog));
      } catch (error) {
        if (newKey) await this.prune(readConnectionCatalog(this.catalogPath), values).catch(deferCleanup);
        throw error;
      }
      await this.prune(catalog, values).catch(deferCleanup);
    });
  }
}
export function connectionRuntime(connection, credentials = new ModelCredentialStore(connection.connectionStore, connection), model = connectionModel(connection)) {
  const native = factories[connection.kind]?.();
  const factory = apis[model.api]; if (!factory) throw new Error('不支持此模型协议');
  const provider = createProvider({ id: model.provider, name: connection.name || connection.model, baseUrl: model.baseUrl,
    auth: connection.kind === 'codex' || connection.kind === 'grok' ? { oauth: connection.authMode === 'grok-local' ? { ...native.auth.oauth, refresh: refreshLocalGrok } : native.auth.oauth } : { apiKey: { name: 'API Key', resolve: async ({ credential }) => {
      const key = credential?.key || connection.apiKey || envValue(connection.apiKeyEnv, connection.environmentFile);
      return key || connection.allowNoKey ? { auth: { apiKey: key || 'summon-keyless' }, source: connection.apiKeyEnv || 'API Key' } : undefined;
    } } },
    models: [model], api: factory() });
  const models = createModels({ credentials }); models.setProvider(provider);
  return { model, models, provider, credentials };
}
export function modelError(error) {
  return String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:sk-|xai-)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/(["']?(?:access_token|refresh_token|api_key)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]').slice(0, 700);
}
