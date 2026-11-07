import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectionPath, readConnectionCatalog, saveModelJson, modelConnection, connectionModel, connectionRuntime,
  ModelCredentialStore, localCodexAuthPath, localGrokAuthPath, localGrokLogin, grokProxyHeaders, codexCredential, decodeModelToken, modelChoices, modelError } from '../../bot/src/agent/connections.mjs';
import { DesktopCodex } from '../codex/desktop.mjs';
import { cliExecutorStates, desktopExecutorState, isCliExecutor } from '../../bot/src/capabilities/executor-connections.mjs';
import { confirmWorkCli, readCodexCliRateLimits } from '../../bot/src/runtime/cli-work-engine.mjs';
import { ensureCodexConnector, stopCodexConnector } from '../../scripts/installation/auxiliaries.mjs';

const number = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = value => Math.min(100, Math.max(0, value));
const epoch = value => typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
const date = value => { const ms = epoch(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const at = (value, path) => String(path || '').split('.').filter(Boolean).reduce((item, key) => item?.[key], value);
const windowLabel = minutes => minutes === 10080 ? '每周' : minutes === 300 ? '每 5 小时' : minutes === 1440 ? '每日' : minutes ? `${minutes} 分钟` : '订阅额度';
const amount = (value, currency) => number(value) === null ? null : { amount: number(value), currency };
const requireEntry = (catalog, id) => { const entry = catalog.connections.find(item => item.id === id); if (!entry) throw new Error('找不到这个模型连接'); return entry; };
const quotaExecutors = ['codex-cli', 'codex-desktop'];

/** Model credentials and account usage belong to the existing host, outside Bot conversation history. */
export class ModelConnections {
  constructor({ dataRoot, model, emit = () => {} }) {
    this.dataRoot = dataRoot; this.initialModel = model; this.emit = emit; this.path = connectionPath(dataRoot);
    this.credentials = new ModelCredentialStore(this.path); this.logins = new Map(); this.usage = {}; this.pendingUsage = new Map(); this.writeChain = Promise.resolve();
    this.usagePath = join(dataRoot, 'config', 'model-usage.json');
  }
  async initialize() {
    if (!existsSync(this.path)) {
      const original = this.initialModel || {};
      await saveModelJson(this.path, { schemaVersion: 1, activeId: 'api-deepseek', environmentFile: join(this.dataRoot, 'config', 'runtime.env'),
        connections: [{ id: 'api-deepseek', kind: 'api', name: original.provider === 'deepseek' ? 'DeepSeek' : '现有 API', provider: original.provider || 'openai-compatible',
          api: original.api || 'openai-completions', baseUrl: original.baseUrl || 'https://api.deepseek.com/v1', model: original.model || 'deepseek-flash',
          apiKeyEnv: original.apiKeyEnv, contextWindow: original.contextWindow || 1048576, maxTokens: original.maxTokens || 393216, thinkingLevel: original.thinkingLevel || 'high' }] });
      if (original.apiKey) await this.credentials.modify('api-deepseek', async () => ({ type: 'api_key', key: original.apiKey }));
    }
    try { this.usage = JSON.parse(await readFile(this.usagePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!desktopExecutorState({ dataRoot: this.dataRoot }).enabled && this.usage['codex-desktop']) {
      delete this.usage['codex-desktop']; await saveModelJson(this.usagePath, this.usage);
    }
    const deploymentPath = join(this.dataRoot, 'config', 'deployment.json');
    if (existsSync(deploymentPath)) {
      const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
      if (deployment.model?.connectionStore !== this.path || Object.keys(deployment.model || {}).length !== 1)
        await saveModelJson(deploymentPath, { ...deployment, model: { connectionStore: this.path } });
    }
    this.timer = setInterval(() => { void this.refreshUsage().catch(() => {}); }, 60000); this.timer.unref();
    return this;
  }
  catalog() { return readConnectionCatalog(this.path); }
  runtimeModel() { return this.catalog().activeId ? modelConnection({ connectionStore: this.path }) : null; }
  async mutate(fn) {
    const result = this.writeChain.catch(() => {}).then(async () => {
      const catalog = this.catalog(), value = await fn(catalog); await saveModelJson(this.path, catalog);
      this.emit('models.changed', {}); return value;
    });
    this.writeChain = result; return result;
  }
  publicEntry(entry) {
    const { authFile, authScope, apiKeyEnv, environmentFile, ...value } = entry;
    return { ...value, active: entry.id === this.catalog().activeId, usage: this.usageFor(entry.id) };
  }
  usageFor(id) {
    const usage = this.usage[id];
    return this.pendingUsage.has(id) && !usage?.checkedAt ? { status: 'loading' } : usage || null;
  }
  clearUsage(id) {
    this.pendingUsage.get(id)?.controller.abort();
    this.pendingUsage.delete(id);
    delete this.usage[id];
  }
  summary() {
    const catalog = this.catalog(), selected = catalog.activeId ? requireEntry(catalog, catalog.activeId) : null;
    const executor = desktopExecutorState({ dataRoot: this.dataRoot });
    const executors = [...cliExecutorStates(catalog), ...(executor.enabled ? [executor] : [])].map(item => ({
      ...item, usage: !item.enabled ? { status: 'not_connected', note: item.note } : quotaExecutors.includes(item.id) ? this.usageFor(item.id)
        : { status: 'unsupported', unsupported: true, note: '当前工作引擎没有可用的额度查询接口。' },
    }));
    const workExecutor = catalog.workExecutorId === 'pi'
      ? { id: 'pi', name: '内置 Pi', kind: 'pi', role: 'executor', enabled: true, label: '当前工作引擎', usage: { status: 'shared', note: '内置 Pi 使用聊天引擎的额度。' } }
      : executors.find(item => item.enabled && item.id === catalog.workExecutorId) || null;
    return { activeId: selected?.id || null, chat: selected ? { ...this.publicEntry(selected), role: 'chat' }
      : { role: 'chat', name: '尚未选择聊天模型', configured: false, usage: { status: 'unconfigured' } },
      executors, workExecutor };
  }
  setExecutor(id, enabled, { select = false, bridgePath, signal } = {}) {
    if ((id !== 'codex-desktop' && !isCliExecutor(id)) || typeof enabled !== 'boolean') throw new Error('请选择有效的执行引擎接入状态');
    const change = (this.executorChange || Promise.resolve()).catch(() => {}).then(() => this.changeExecutor(id, enabled, select, bridgePath, signal));
    this.executorChange = change;
    return change.finally(() => { if (this.executorChange === change) this.executorChange = null; });
  }
  async changeExecutor(id, enabled, select, bridgePath, signal) {
    signal?.throwIfAborted();
    const desktop = id === 'codex-desktop';
    const bridge = bridgePath === undefined ? this.catalog().executors?.[id]?.bridgePath : bridgePath;
    if (enabled && desktop) {
      const connection = await ensureCodexConnector(this.dataRoot);
      try { await new DesktopCodex({ dataRoot: this.dataRoot }).connect(connection); }
      catch (error) {
        if (connection.managed && !desktopExecutorState({ dataRoot: this.dataRoot }).enabled) await stopCodexConnector(this.dataRoot);
        throw error;
      }
    }
    if (enabled && !desktop) await confirmWorkCli(id, { bridgePath: bridge, signal });
    signal?.throwIfAborted();
    await this.mutate(catalog => {
      catalog.executors = { ...catalog.executors, [id]: { enabled, ...(bridge ? { bridgePath: bridge } : {}), ...(enabled ? { connectedAt: new Date().toISOString() } : {}) } };
      if (enabled && select) catalog.workExecutorId = id;
      if (!enabled && catalog.workExecutorId === id) catalog.workExecutorId = 'pi';
      this.clearUsage(id);
    });
    if (desktop && !enabled) await stopCodexConnector(this.dataRoot);
    await saveModelJson(this.usagePath, this.usage);
    if (enabled && quotaExecutors.includes(id)) {
      void this.refreshOne(id, true).then(() => saveModelJson(this.usagePath, this.usage)).catch(() => {});
    }
    return this.snapshot();
  }
  async selectWorkExecutor(id) {
    await this.mutate(catalog => {
      const connected = (id === 'codex-desktop' || isCliExecutor(id)) && catalog.executors?.[id]?.enabled === true;
      if (id !== 'pi' && !connected) throw new Error('请先接入这个工作引擎。');
      catalog.workExecutorId = id;
    });
    return this.snapshot();
  }
  async snapshot() {
    const catalog = this.catalog(), credentials = await this.credentials.list();
    const configured = new Set(credentials.map(item => item.providerId));
    const connections = catalog.connections.map(entry => ({ ...this.publicEntry(entry), configured: configured.has(entry.id) || entry.allowNoKey === true }));
    const summary = this.summary();
    return { ...summary, chat: { ...summary.chat, configured: connections.some(entry => entry.active && entry.configured) }, connections,
      presets: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
        { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
        { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', api: 'openai-responses' },
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
        { id: 'openai-compatible', name: '其他 / 自定义地址', baseUrl: '', api: 'openai-completions' }].map(preset => ({ ...preset,
          models: modelChoices('api', preset.id).map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens })) })) };
  }
  async save(input) {
    if (!['api', 'codex', 'grok'].includes(input.kind)) throw new Error('请选择 Codex 订阅、Grok 订阅或通用 API');
    const id = input.id || `${input.kind}-${randomUUID()}`;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('无效的连接编号');
    await this.mutate(async catalog => {
      const original = structuredClone(catalog);
      const previous = catalog.connections.find(item => item.id === id);
      if (previous && previous.kind !== input.kind) throw new Error('请为不同类型建立新的连接');
      const name = String(input.name || previous?.name || (input.kind === 'api' ? 'API' : input.kind === 'codex' ? 'Codex 订阅' : 'Grok 订阅')).trim().slice(0, 80);
      const entry = { ...previous, id, kind: input.kind, name, model: String(input.model || previous?.model || (input.kind === 'codex' ? 'gpt-6-luna' : input.kind === 'grok' ? 'grok-4.7' : '')).trim(),
        provider: input.kind === 'codex' ? 'openai-codex' : input.kind === 'grok' ? 'xai' : String(input.provider || previous?.provider || 'openai-compatible'),
        baseUrl: input.kind === 'codex' ? 'https://chatgpt.com/backend-api' : input.kind === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : String(input.baseUrl || previous?.baseUrl || '').trim().replace(/\/+$/, ''),
        api: input.kind === 'codex' ? 'openai-codex-responses' : input.kind === 'grok' ? 'openai-responses' : input.api || previous?.api || 'openai-completions',
        contextWindow: Number(input.contextWindow || previous?.contextWindow || (input.kind === 'codex' ? 1050000 : input.kind === 'grok' ? 500000 : 128000)),
        maxTokens: Number(input.maxTokens || previous?.maxTokens || 8192), thinkingLevel: input.thinkingLevel || previous?.thinkingLevel || 'high',
        allowNoKey: input.kind === 'api' && input.allowNoKey === true,
        ...(input.kind === 'api' ? { balancePath: String(input.balancePath ?? previous?.balancePath ?? '').trim(), balanceField: String(input.balanceField ?? previous?.balanceField ?? '').trim(), balanceCurrency: String(input.balanceCurrency || previous?.balanceCurrency || 'USD').slice(0, 8) } : {}) };
      if (!entry.model || entry.model.length > 200 || /[\u0000-\u001f]/.test(entry.model)) throw new Error('请填写有效的模型 ID');
      if (!['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(entry.thinkingLevel)) throw new Error('无效的思考强度');
      const endpoint = new URL(entry.baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('请填写不含凭据、查询参数的模型 API 地址');
      if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'openai-codex-responses'].includes(entry.api) || input.kind === 'api' && entry.api === 'openai-codex-responses') throw new Error('请选择有效的 API 协议');
      if (entry.balancePath && (!entry.balancePath.startsWith('/') || entry.balancePath.startsWith('//') || new URL(entry.balancePath, entry.baseUrl).origin !== endpoint.origin)) throw new Error('余额查询路径必须位于同一个 API 服务');
      connectionModel(entry);
      if (input.apiKey !== undefined && input.apiKey !== '' && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16000)) throw new Error('无效的 API Key');
      if (previous) catalog.connections[catalog.connections.indexOf(previous)] = entry; else catalog.connections.push(entry);
      // Write the entry before the credential store resolves its metadata.
      await saveModelJson(this.path, catalog);
      try {
        if (input.apiKey !== undefined && input.apiKey !== '') {
          await this.credentials.modify(id, async () => ({ type: 'api_key', key: input.apiKey.trim() }));
          delete entry.apiKeyEnv;
        }
        if (input.kind === 'api' && !entry.allowNoKey && !await this.credentials.read(id)) throw new Error('请填写 API Key，或选择无需 Key 的本地服务');
      } catch (error) { await saveModelJson(this.path, original); throw error; }
      delete this.usage[id];
    });
    return this.snapshot();
  }
  async select(id) {
    const connection = requireEntry(this.catalog(), id);
    if (!connection.allowNoKey && !await this.credentials.read(id)) throw new Error('请先完成这个连接的授权');
    await this.mutate(catalog => { requireEntry(catalog, id); catalog.activeId = id; });
    void this.refreshUsage(true).catch(() => {}); return this.snapshot();
  }
  async remove(id) {
    if (this.catalog().activeId === id) throw new Error('请先选择其他聊天模型，再移除此连接');
    this.cancelLogin(id);
    await this.mutate(async catalog => { requireEntry(catalog, id); await this.credentials.delete(id); catalog.connections = catalog.connections.filter(entry => entry.id !== id); delete this.usage[id]; });
    return this.snapshot();
  }
  async localLogins() {
    const sources = await Promise.all(['codex', 'grok'].map(async kind => {
      const name = kind === 'codex' ? 'Codex' : 'Grok', path = kind === 'codex' ? localCodexAuthPath() : localGrokAuthPath();
      try {
        const raw = await readFile(path, 'utf8');
        let value; try { value = JSON.parse(raw); } catch { return { kind, name, available: false, status: 'unreadable', note: `${name} 登录文件无法读取，可以重新授权订阅。` }; }
        if (kind === 'codex') codexCredential(value); else localGrokLogin(value);
        return { kind, name, available: true, status: 'available', note: `找到可导入的 ${name} 登录。` };
      } catch (error) {
        return { kind, name, available: false, status: error.code === 'ENOENT' ? 'missing' : 'unavailable',
          note: error.code === 'ENOENT' ? `未找到可导入的 ${name} 登录。` : `${name} 登录暂不可导入，可以重新授权订阅。` };
      }
    }));
    return { scope: 'host', sources };
  }
  async importLocal(kind) {
    if (!['codex', 'grok'].includes(kind)) throw new Error('请选择 Codex 或 Grok');
    const name = kind === 'codex' ? 'Codex' : 'Grok', authMode = `${kind}-local`;
    const authFile = kind === 'codex' ? localCodexAuthPath() : localGrokAuthPath();
    let value; try { value = JSON.parse(await readFile(authFile, 'utf8')); } catch { throw new Error(`无法读取本机 ${name} 登录，请在这台机器上登录，或使用订阅授权`); }
    let identity, authScope;
    if (kind === 'codex') { const credential = codexCredential(value); identity = decodeModelToken(value.tokens.id_token || credential.access).email || '本机 Codex 账号'; }
    else { const login = localGrokLogin(value); identity = login.identity; authScope = login.authScope; }
    const existing = this.catalog().connections.find(entry => entry.authMode === authMode), id = existing?.id || authMode;
    if (!existing) await this.save({ kind, id, name: `本机 ${name} 订阅` });
    await this.mutate(catalog => { const entry = requireEntry(catalog, id);
      entry.authMode = authMode; entry.authFile = authFile; entry.identity = identity;
      if (kind === 'grok') { entry.authScope = authScope; entry.baseUrl = 'https://cli-chat-proxy.grok.com/v1'; }
      delete this.usage[id]; });
    return { ...await this.snapshot(), importedId: id };
  }
  loginStatus(id) {
    const login = this.logins.get(id);
    if (!login) return { id, status: 'idle' };
    const { controller, promise, ...publicStatus } = login; return publicStatus;
  }
  startLogin(id) {
    const connection = modelConnection({ connectionStore: this.path }, id);
    if (!['codex', 'grok'].includes(connection.kind) || ['codex-local', 'grok-local'].includes(connection.authMode)) throw new Error('这个连接不使用独立订阅授权');
    this.cancelLogin(id);
    const controller = new AbortController(), login = { id, status: 'starting', controller, startedAt: new Date().toISOString() };
    this.logins.set(id, login);
    const runtime = connectionRuntime(connection, this.credentials);
    login.promise = runtime.models.login(id, 'oauth', { signal: controller.signal,
      prompt: async prompt => { if (prompt.type === 'select' && prompt.options.some(option => option.id === 'device_code')) return 'device_code'; throw new Error('此授权需要设备码登录'); },
      notify: event => { if (this.logins.get(id) !== login) return;
        if (event.type === 'device_code') { login.status = 'waiting'; login.userCode = event.userCode; login.verificationUri = event.verificationUri;
          login.expiresAt = new Date(Date.now() + (event.expiresInSeconds || 600) * 1000).toISOString(); }
      } }, { agentName: 'Summon Bot' }).then(async () => {
        if (this.logins.get(id) !== login || controller.signal.aborted) return;
        login.status = 'completed'; delete login.userCode; delete login.verificationUri;
        this.emit('models.changed', {}); await this.refreshOne(id, true);
      }).catch(error => { if (this.logins.get(id) === login) { login.status = controller.signal.aborted ? 'cancelled' : 'failed'; login.error = controller.signal.aborted ? null : modelError(error); delete login.userCode; delete login.verificationUri; } });
    return this.loginStatus(id);
  }
  cancelLogin(id) { const login = this.logins.get(id); if (login) { login.controller.abort(); login.status = 'cancelled'; delete login.userCode; delete login.verificationUri; } }
  async choices(id, discover = false) {
    const connection = modelConnection({ connectionStore: this.path }, id);
    const builtins = modelChoices(connection.kind, connection.provider);
    if (!discover || connection.kind !== 'api') return { models: builtins, source: 'catalog' };
    const runtime = connectionRuntime(connection, this.credentials), resolved = await runtime.models.getAuth(id);
    if (!resolved) throw new Error('请先配置 API Key');
    const path = connection.baseUrl.replace(/\/+$/, '') + (connection.api === 'anthropic-messages' && !connection.baseUrl.endsWith('/v1') ? '/v1/models' : '/models');
    const headers = connection.api === 'anthropic-messages' ? { 'x-api-key': resolved.auth.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${resolved.auth.apiKey}` };
    const result = await this.fetchJson(path, headers);
    const entries = result.data || result.models;
    if (!Array.isArray(entries)) throw new Error('供应商未返回可识别的模型目录，可直接填写模型 ID');
    return { source: 'provider', models: entries.filter(entry => typeof entry.id === 'string' || typeof entry.slug === 'string').map(entry => ({ id: entry.id || entry.slug, name: entry.display_name || entry.name || entry.id || entry.slug })) };
  }
  async fetchJson(url, headers) {
    const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw new Error(`额度或目录查询返回 HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('供应商未返回有效的 JSON'); }
  }
  async accountUsage(id, signal) {
    if (id === 'codex-cli') {
      const result = await readCodexCliRateLimits({ bridgePath: this.catalog().executors?.[id]?.bridgePath, signal });
      const allLimits = Object.entries(result.rateLimitsByLimitId || {});
      const limits = allLimits.length ? allLimits : [['codex', result.rateLimits]];
      const windows = limits.flatMap(([limitId, bucket]) => ['primary', 'secondary'].flatMap(field => {
        const value = bucket?.[field], used = number(value?.usedPercent);
        if (used === null) return [];
        const durationMinutes = number(value.windowDurationMins);
        return [{ name: `${bucket.limitName || (limitId === 'codex' ? 'Codex' : limitId)} · ${windowLabel(durationMinutes)}`,
          limitId, durationMinutes, remainingPercent: clamp(100 - used), resetsAt: date(value.resetsAt) }];
      }));
      const main = result.rateLimitsByLimitId?.codex || result.rateLimits;
      return { source: 'Codex 订阅', plan: main?.planType || null, windows,
        credits: number(main?.credits?.balance), unlimited: main?.credits?.unlimited === true };
    }
    if (id === 'codex-desktop') {
      const result = await new DesktopCodex({ dataRoot: this.dataRoot }).request('/v1/account/usage', { signal: AbortSignal.timeout(10000) });
      const values = result.windows || result.weekly || [];
      return { source: 'Codex 桌面端', plan: result.planType || null, windows: values.map(value => ({ name: value.label || windowLabel(value.windowDurationMins),
        limitId: value.limitId, durationMinutes: number(value.windowDurationMins), remainingPercent: number(value.remaining), resetsAt: value.periodEnd || null })),
        credits: number(result.credits?.balance), unlimited: result.credits?.unlimited === true };
    }
    const connection = modelConnection({ connectionStore: this.path }, id), runtime = connectionRuntime(connection, this.credentials);
    const resolved = await runtime.models.getAuth(id);
    if (!resolved) throw new Error('尚未配置或授权');
    const key = resolved.auth.apiKey;
    if (connection.kind === 'codex') {
      const claims = decodeModelToken(key), accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
      const usage = await this.fetchJson('https://chatgpt.com/backend-api/wham/usage', { Authorization: `Bearer ${key}`, ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}) });
      const buckets = [{ name: 'Codex', value: usage.rate_limit }, ...(usage.additional_rate_limits || []).map(value => ({ name: value.limit_name || value.metered_feature || '模型', value: value.rate_limit }))];
      const windows = buckets.flatMap(bucket => ['primary_window', 'secondary_window'].flatMap(field => {
        const value = bucket.value?.[field], used = number(value?.used_percent);
        if (!value || used === null) return [];
        return [{ name: `${bucket.name} · ${windowLabel(number(value.limit_window_seconds) / 60)}`, durationMinutes: number(value.limit_window_seconds) === null ? null : number(value.limit_window_seconds) / 60,
          remainingPercent: clamp(100 - used), resetsAt: date(value.reset_at) }];
      }));
      return { source: 'ChatGPT 订阅', plan: usage.plan_type || null, windows, credits: usage.credits?.has_credits ? number(usage.credits.balance) : null,
        unlimited: usage.credits?.unlimited === true, accountId };
    }
    if (connection.kind === 'grok') {
      const headers = { Authorization: `Bearer ${key}`, ...grokProxyHeaders(connection) };
      const [billing, settings] = await Promise.all([this.fetchJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', headers),
        this.fetchJson('https://cli-chat-proxy.grok.com/v1/settings', headers).catch(() => null)]);
      const config = billing.config || billing, period = config.currentPeriod;
      const used = number(config.creditUsagePercent), resetsAt = date(period?.end || config.billingPeriodEnd);
      const prepaid = number(config.prepaidBalance?.val ?? config.prepaidBalance);
      const weekly = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' || period?.periodType === 'USAGE_PERIOD_TYPE_WEEKLY';
      return { source: 'Grok 订阅', plan: settings?.subscription_tier_display || null,
        windows: used === null ? [] : [{ name: weekly ? '每周共享额度' : '共享额度', durationMinutes: weekly ? 10080 : null, remainingPercent: clamp(100 - used), resetsAt }],
        balance: prepaid === null ? null : amount(prepaid / 100, 'USD'), note: used === null ? '供应商未返回已用比例' : null };
    }
    const headers = { Authorization: `Bearer ${key}` };
    if (connection.provider === 'deepseek' && new URL(connection.baseUrl).hostname === 'api.deepseek.com') {
      const result = await this.fetchJson('https://api.deepseek.com/user/balance', headers);
      return { source: 'DeepSeek 余额', windows: [], balances: (result.balance_infos || []).flatMap(item => { const value = amount(item.total_balance, item.currency); return value ? [value] : []; }) };
    }
    if (connection.provider === 'openrouter' && new URL(connection.baseUrl).hostname === 'openrouter.ai') {
      const result = await this.fetchJson('https://openrouter.ai/api/v1/credits', headers);
      const total = number(result.data?.total_credits), used = number(result.data?.total_usage);
      return { source: 'OpenRouter 余额', windows: [], balance: total !== null && used !== null ? amount(total - used, 'USD') : null };
    }
    if (connection.balancePath && connection.balanceField) {
      const result = await this.fetchJson(new URL(connection.balancePath, connection.baseUrl), connection.api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : headers);
      const balance = amount(at(result, connection.balanceField), connection.balanceCurrency || 'USD');
      if (!balance) throw new Error('余额接口未返回指定的数值字段');
      return { source: '供应商余额接口', windows: [], balance };
    }
    return { source: 'API', windows: [], unsupported: true, note: '此服务未配置余额查询接口，可在设置中补充' };
  }
  refreshOne(id, force = false) {
    if (quotaExecutors.includes(id) && this.catalog().executors?.[id]?.enabled !== true) return Promise.resolve(null);
    if (this.pendingUsage.has(id)) return this.pendingUsage.get(id).promise;
    const previous = this.usage[id];
    if (!force && Date.now() - Date.parse(previous?.attemptedAt || previous?.checkedAt) < 60000) return Promise.resolve(previous);
    const pending = { controller: new AbortController() };
    pending.promise = this.accountUsage(id, pending.controller.signal).then(value => ({
      ...value, status: value.unsupported ? 'unsupported' : 'ready', checkedAt: new Date().toISOString(),
    }), error => ({ ...previous, status: 'error', error: modelError(error), attemptedAt: new Date().toISOString(), stale: Boolean(previous?.checkedAt) }))
      .then(usage => {
        if (this.pendingUsage.get(id) !== pending) return null;
        this.pendingUsage.delete(id);
        this.usage[id] = usage;
        this.emit('models.usage', {});
        return usage;
      });
    this.pendingUsage.set(id, pending);
    if (!previous?.checkedAt) this.emit('models.usage', {});
    return pending.promise;
  }
  async refreshUsage(force = false) {
    const catalog = this.catalog();
    const ids = [catalog.activeId, ...quotaExecutors.filter(id => catalog.executors?.[id]?.enabled)].filter(Boolean);
    await Promise.all(ids.map(id => this.refreshOne(id, force)));
    await saveModelJson(this.usagePath, this.usage); return this.summary();
  }
  async close() { clearInterval(this.timer); for (const id of this.logins.keys()) this.cancelLogin(id); await Promise.allSettled([...this.logins.values()].map(login => login.promise)); await Promise.allSettled([...this.pendingUsage.values()].map(item => item.promise)); await this.writeChain.catch(() => {}); }
}
