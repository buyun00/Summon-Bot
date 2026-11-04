import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, createProvider } from '@earendil-works/pi-ai';
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
export const readConnectionCatalog = path => JSON.parse(readFileSync(path, 'utf8'));
export async function saveModelJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function modelConnection(config, id) {
  if (!config.connectionStore) return { kind: 'api', id: config.provider || 'api', ...config };
  const catalog = readConnectionCatalog(config.connectionStore);
  const selected = catalog.connections.find(item => item.id === (id || catalog.activeId));
  if (!selected) throw new Error('请先在模型与引擎设置中选择聊天模型');
  return { ...selected, connectionStore: config.connectionStore, environmentFile: catalog.environmentFile };
}
export function connectionModel(connection) {
  const native = factories[connection.kind === 'api' ? connection.provider : connection.kind]?.();
  const known = native?.getModels().find(model => model.id === connection.model);
  const api = connection.kind === 'codex' ? 'openai-codex-responses' : connection.kind === 'grok' ? 'openai-responses' : connection.api || 'openai-completions';
  const contextWindow = Number(connection.contextWindow || known?.contextWindow || 128000);
  const maxTokens = Number(connection.maxTokens || known?.maxTokens || 8192);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096 || !Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens >= contextWindow) throw new Error('模型上下文与输出上限设置不正确');
  return { ...known, id: connection.model, name: known?.name || connection.model, type: 'chat', api,
    provider: connection.id || connection.provider, baseUrl: connection.kind === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : connection.baseUrl || native?.baseUrl,
    ...(connection.kind === 'grok' ? { headers: { ...known?.headers, ...grokProxyHeaders(connection) } } : {}),
    reasoning: connection.reasoning !== false, input: known?.input || ['text'], contextWindow, maxTokens,
    cost: connection.kind === 'api' ? known?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(api === 'openai-completions' && !known ? { compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: 'max_tokens' } } : {}) };
}
export function modelChoices(kind, provider) {
  return (factories[kind === 'api' ? provider : kind]?.().getModels() || []).map(model => ({ id: model.id, name: model.name,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, api: model.api }));
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
  while (true) {
    signal?.throwIfAborted();
    try { await mkdir(lock); await writeFile(join(lock, 'owner'), String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => '0'));
      if (owner) {
        try { process.kill(owner, 0); }
        catch (failure) { if (failure.code === 'ESRCH') { await unlink(join(lock, 'owner')).catch(() => {}); await rmdir(lock).catch(() => {}); continue; } }
      }
      await delay(60, undefined, { signal });
    }
  }
  try { return await action(); }
  finally { await unlink(join(lock, 'owner')); await rmdir(lock); }
}
/** Credentials stay on the host. Local logins are referenced; removing a Summon connection does not log out the CLI. */
export class ModelCredentialStore {
  constructor(path, fallback) { this.catalogPath = path; this.path = path ? join(dirname(path), 'model-credentials.json') : null; this.fallback = fallback; this.memory = new Map(); }
  connection(id) { return this.catalogPath ? modelConnection({ connectionStore: this.catalogPath }, id) : this.fallback; }
  async saved() { if (!this.path) return Object.fromEntries(this.memory); try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } }
  async read(id) {
    const connection = this.connection(id);
    if (connection.authMode === 'codex-local') return codexCredential(await readLocalModelAuth(connection.authFile));
    if (connection.authMode === 'grok-local') return localGrokLogin(await readLocalModelAuth(connection.authFile), connection.authScope).credential;
    const stored = (await this.saved())[id];
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
      } else if (this.path) await saveModelJson(this.path, { ...await this.saved(), [id]: next });
      else this.memory.set(id, next);
      return next;
    };
    return this.path ? fileLock(this.path, update, options.signal) : update();
  }
  async delete(id) {
    if (!this.path) { this.memory.delete(id); return; }
    return fileLock(this.path, async () => { const values = await this.saved(); delete values[id]; await saveModelJson(this.path, values); });
  }
}
export function connectionRuntime(connection, credentials = new ModelCredentialStore(connection.connectionStore, connection)) {
  const model = connectionModel(connection), native = factories[connection.kind]?.();
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
