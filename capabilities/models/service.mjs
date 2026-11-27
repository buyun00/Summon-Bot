import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { idOf, reject } from '../platform/contract.mjs';
import { connectionPath, readConnectionCatalog, saveModelJson, modelConnection, connectionModel, connectionRuntime,
  ModelCredentialStore, localCodexAuthPath, localGrokAuthPath, localGrokLogin, grokProxyHeaders, codexCredential, decodeModelToken, modelChoices, modelError,
  modelPurposes, engineTiers, defaultEngineTiers, normalizeModelCatalog,
  validateModelPurpose, resolveConnectionPurpose, resolveBotModelSelection } from '../../bot/src/agent/connections.mjs';

const number = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = value => Math.min(100, Math.max(0, value));
const epoch = value => typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
const date = value => { const ms = epoch(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const at = (value, path) => String(path || '').split('.').filter(Boolean).reduce((item, key) => item?.[key], value);
const windowLabel = minutes => minutes === 10080 ? '每周' : minutes === 300 ? '每 5 小时' : minutes === 1440 ? '每日' : minutes ? `${minutes} 分钟` : '订阅额度';
const amount = (value, currency) => number(value) === null ? null : { amount: number(value), currency };
const requireEntry = (catalog, id) => { const entry = catalog.connections.find(item => item.id === id); if (!entry) throw new Error('找不到这个模型连接'); return entry; };
const validModelId = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/.test(id);
const validThinkingLevel = level => level === null || typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(level);
const unavailable = { name: '模型设置暂不可用', configured: false, usage: { status: 'unavailable' } };

/** Model credentials and account usage belong to the existing host, outside Bot conversation history. */
export class ModelConnections {
  constructor({ dataRoot, model, emit = () => {} }) {
    this.dataRoot = dataRoot; this.initialModel = model; this.emit = emit;
    this.path = connectionPath(dataRoot);
    this.credentials = new ModelCredentialStore(this.path); this.logins = new Map(); this.usage = Object.create(null); this.configured = Object.create(null); this.pendingUsage = new Map(); this.writeChain = Promise.resolve();
    this.usagePath = join(dataRoot, 'config', 'model-usage.json');
    this.engines = null;
    this.platform = null;
    this.getUsageDb = null;
    this.connModelsCache = new Map();
    this.autoRecommendInFlight = null;
  }
  attach({ engines = null, platform = null, getUsageDb = null } = {}) {
    if (engines) this.engines = engines;
    if (platform) this.platform = platform;
    if (getUsageDb) this.getUsageDb = getUsageDb;
  }
  async initialize() {
    if (!existsSync(this.path)) {
      const original = this.initialModel;
      const configured = original?.baseUrl && original.model;
      const activeId = configured ? 'api-deepseek' : null;
      const connections = configured ? [{ id: activeId, kind: 'api', name: original.provider === 'deepseek' ? 'DeepSeek' : '现有 API',
        provider: original.provider || 'openai-compatible', api: original.api || 'openai-completions', baseUrl: original.baseUrl, model: original.model,
        apiKeyEnv: original.apiKeyEnv, allowNoKey: original.allowNoKey, contextWindow: original.contextWindow,
        maxTokens: original.maxTokens, thinkingLevel: original.thinkingLevel ?? null }] : [];
      await saveModelJson(this.path, normalizeModelCatalog({ schemaVersion: 3, activeId, environmentFile: join(this.dataRoot, 'config', 'runtime.env'), connections }));
      if (activeId && original.apiKey) await this.credentials.modify(activeId, async () => ({ type: 'api_key', key: original.apiKey }));
    } else {
      try {
        const raw = JSON.parse(await readFile(this.path, 'utf8'));
        if (Array.isArray(raw?.connections) && (raw.schemaVersion !== 3 || !raw.roleRouting || Object.hasOwn(raw, 'purposeDefaults') || Object.hasOwn(raw, 'connectionPurposes') || Object.hasOwn(raw, 'externalEngines'))) {
          await saveModelJson(this.path, normalizeModelCatalog(raw));
        }
      } catch {}
    }
    await this.credentials.pruneUnreferenced().catch(() => this.deferCredentialCleanup());
    try {
      const cached = JSON.parse(await readFile(this.usagePath, 'utf8'));
      if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
        for (const [id, value] of Object.entries(cached)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) this.usage[id] = value;
        }
      } else this.usageUnavailable = true;
    } catch (error) { this.usageUnavailable = error.code !== 'ENOENT'; }
    await this.syncConfigured().catch(() => {});
    return this;
  }
  async syncConfigured(catalog) {
    const current = catalog ?? this.catalog();
    const next = Object.create(null);
    await Promise.all(current.connections.map(async entry => {
      try { connectionModel(entry); } catch { next[entry.id] = false; return; }
      if (entry.allowNoKey === true) { next[entry.id] = true; return; }
      try { next[entry.id] = Boolean(await this.credentials.read(entry.id)); }
      catch { next[entry.id] = false; }
    }));
    this.configured = next;
    return next;
  }
  isConfigured(entry) {
    if (!entry) return false;
    if (typeof this.configured[entry.id] === 'boolean') return this.configured[entry.id];
    if (entry.allowNoKey === true) return true;
    if (['codex-local', 'grok-local'].includes(entry.authMode)) return Boolean(entry.authFile && existsSync(entry.authFile));
    return false;
  }

  async pauseUsage() {
    const pending = [...this.pendingUsage.values()];
    for (const { controller } of pending) controller.abort();
    await Promise.allSettled(pending.map(item => item.promise));
    await this.usageWrite?.catch(() => {});
  }
  catalog() { return readConnectionCatalog(this.path); }
  requireConnection(catalog, id) {
    const entry = catalog.connections.find(item => item.id === id);
    if (!entry) reject('connection_not_found', 'Model connection is unavailable', 404);
    return entry;
  }
  resolveForBot(botOrModel, purpose = 'conversation') {
    const botModel = botOrModel && typeof botOrModel === 'object' && Object.hasOwn(botOrModel, 'model') ? botOrModel.model : botOrModel;
    if (!botModel) return null;
    try { return resolveBotModelSelection(this.catalog(), botModel, purpose); }
    catch { return null; }
  }
  resolveAllForBot(botOrModel) {
    const botModel = botOrModel && typeof botOrModel === 'object' && Object.hasOwn(botOrModel, 'model') ? botOrModel.model : botOrModel;
    if (!botModel) return { fast_read: null, conversation: null, pi_session: null };
    try {
      const catalog = this.catalog();
      return Object.fromEntries(modelPurposes.map(purpose => [purpose, resolveBotModelSelection(catalog, botModel, purpose)]));
    } catch {
      return { fast_read: null, conversation: null, pi_session: null };
    }
  }
  engineTiersFor(catalog, engineId) {
    const saved = catalog?.engineRouting?.[engineId];
    if (saved && typeof saved === 'object' && Object.keys(saved).length) return structuredClone(saved);
    return defaultEngineTiers(engineId);
  }
  engineTiers(engineId) {
    try { return this.engineTiersFor(this.catalog(), engineId); }
    catch { return defaultEngineTiers(engineId); }
  }
  effectivePurposes(entry, catalog) {
    return Object.fromEntries(modelPurposes.map(purpose => [purpose, resolveConnectionPurpose(catalog, entry.id, purpose)]));
  }
  selectBinding(selection) {
    if (selection === undefined) return { mode: 'follow_default' };
    if (selection === null) return null;
    if (typeof selection === 'object' && !Array.isArray(selection) && selection.mode === 'follow_default') {
      return { mode: 'follow_default' };
    }
    const catalog = this.catalog();
    if (typeof selection === 'string' || (typeof selection === 'object' && !Array.isArray(selection) && selection.kind === 'connection')) {
      const connectionId = idOf(selection, 'connection');
      this.requireConnection(catalog, connectionId);
      return { mode: 'follow_connection', connection_id: connectionId };
    }
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      reject('invalid_model_binding', 'Choose a valid model binding');
    }
    if (selection.mode === 'follow_connection') {
      const connectionId = idOf(selection.connection_id, 'connection');
      this.requireConnection(catalog, connectionId);
      return { mode: 'follow_connection', connection_id: connectionId };
    }
    if (selection.mode !== undefined && selection.mode !== 'custom') {
      reject('invalid_model_binding', 'Unsupported model binding mode');
    }
    const connectionId = idOf(selection.connection_id, 'connection');
    const entry = this.requireConnection(catalog, connectionId);
    const id = selection.id === undefined || selection.id === null || selection.id === '' ? undefined : String(selection.id).trim();
    if (id !== undefined && !validModelId(id)) reject('invalid_model_id', 'Choose a valid model ID');
    const thinking_level = selection.thinking_level === undefined || selection.thinking_level === '' ? null : selection.thinking_level;
    if (!validThinkingLevel(thinking_level)) reject('invalid_thinking_level', 'Choose a valid reasoning level');
    if (id !== undefined || thinking_level !== null) {
      try { validateModelPurpose(entry, id || entry.model, thinking_level); }
      catch (error) { reject('invalid_thinking_level', error.message); }
    }
    let purposes;
    if (selection.purposes && typeof selection.purposes === 'object' && !Array.isArray(selection.purposes)) {
      const next = {};
      for (const purpose of modelPurposes) {
        const item = selection.purposes[purpose];
        if (!item || typeof item !== 'object') continue;
        const targetConnId = item.connection_id ? idOf(item.connection_id, 'connection') : connectionId;
        const targetConn = this.requireConnection(catalog, targetConnId);
        const targetId = item.id === undefined || item.id === null || item.id === '' ? undefined : String(item.id).trim();
        if (targetId !== undefined && !validModelId(targetId)) reject('invalid_model_id', 'Choose a valid model ID');
        const targetThinking = item.thinking_level === undefined ? undefined : (item.thinking_level === '' ? null : item.thinking_level);
        if (targetThinking !== undefined && !validThinkingLevel(targetThinking)) reject('invalid_thinking_level', 'Choose a valid reasoning level');
        if (targetConnId === connectionId && targetId === undefined && targetThinking === undefined) continue;
        const probeModel = targetId || resolveConnectionPurpose(catalog, targetConnId, purpose)?.id || targetConn.model;
        if (targetThinking !== undefined) {
          try { validateModelPurpose(targetConn, probeModel, targetThinking); }
          catch (error) { reject('invalid_thinking_level', error.message); }
        }
        next[purpose] = {
          ...(item.connection_id ? { connection_id: targetConnId } : {}),
          ...(targetId !== undefined ? { id: targetId } : {}),
          ...(targetThinking !== undefined ? { thinking_level: targetThinking } : {}),
        };
      }
      if (Object.keys(next).length) purposes = next;
    }
    return {
      mode: 'custom',
      connection_id: connectionId,
      ...(id !== undefined ? { id } : {}),
      thinking_level,
      ...(purposes ? { purposes } : {}),
    };
  }
  deferCredentialCleanup() {
    if (this.cleanupTimer || this.closing) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.cleanupTask = this.credentials.pruneUnreferenced().catch(() => this.deferCredentialCleanup());
    }, 5000);
    this.cleanupTimer.unref();
  }
  async mutate(fn, newKey, afterCommit) {
    const result = this.writeChain.catch(() => {}).then(async () => {
      await this.credentials.updateCatalog(fn, newKey, () => this.deferCredentialCleanup());
      afterCommit?.();
      await this.syncConfigured().catch(() => {});
      this.emit('models.changed', {});
    });
    this.writeChain = result; return result;
  }
  publicEntry(entry, activeId, catalog) {
    const { id, kind, name, model, provider, baseUrl, api, thinkingLevel, allowNoKey, balancePath, balanceField, balanceCurrency,
      contextWindow, maxTokens, authMode, identity } = entry;
    const base = { id, kind, name, model, provider, baseUrl, api, thinkingLevel: thinkingLevel ?? null, allowNoKey, balancePath, balanceField, balanceCurrency,
      contextWindow, maxTokens, authMode, identity,
      active: id === activeId, usage: this.usageFor(id),
      ...(catalog ? { effectivePurposes: this.effectivePurposes(entry, catalog) } : {}) };
    try {
      const effective = connectionModel(entry);
      return { ...base, configured: this.isConfigured(entry), thinkingLevels: effective.thinkingLevels, effectiveBudget: { contextWindow: effective.contextWindow,
        maxTokens: effective.maxTokens, outputTokenLimit: effective.outputTokenLimit, source: effective.budgetSource } };
    } catch { return { ...base, configured: false, usage: { status: 'unavailable' } }; }
  }
  usageFor(id) {
    const usage = this.usage[id];
    if (this.pendingUsage.has(id) && !usage?.checkedAt) return { status: 'loading' };
    return usage ?? (this.usageUnavailable ? { status: 'unavailable' } : null);
  }
  clearUsage(id) {
    this.pendingUsage.get(id)?.controller.abort();
    this.pendingUsage.delete(id);
    this.connModelsCache.delete(id);
    delete this.usage[id];
  }
  supportsQuota(entry) {
    if (!entry) return false;
    if (['codex', 'grok'].includes(entry.kind)) return true;
    if (entry.balancePath && entry.balanceField) return true;
    try {
      const host = new URL(entry.baseUrl).hostname;
      return entry.provider === 'deepseek' && host === 'api.deepseek.com' || entry.provider === 'openrouter' && host === 'openrouter.ai';
    } catch { return false; }
  }
  resolveWorkEngine(catalog) {
    const enabled = this.engines?.available?.() || [];
    const shortLabels = { agy: 'AGY', codex: 'Codex', 'claude-code': 'Claude', 'grok-build': 'Grok' };
    if (!enabled.length) {
      return {
        id: 'executor:none',
        engineId: null,
        kind: 'executor',
        name: '工作引擎',
        model: '',
        enabled: false,
        configured: false,
        role: 'executor',
        roleLabel: '工作引擎',
        label: '未启用',
        usage: { status: 'not_connected', note: '未启用工作引擎' },
        enabledEngines: [],
      };
    }
    const primary = enabled[0];
    const tiers = this.engineTiersFor(catalog, primary.id);
    const defaultModel = tiers.standard?.model || Object.values(tiers)[0]?.model || '';
    const enabledEngines = enabled.map(eng => ({
      id: eng.id,
      name: eng.name,
      shortLabel: shortLabels[eng.id] || eng.name,
    }));
    const roleLabel = shortLabels[primary.id] || '工作引擎';
    if (primary.id === 'codex' && existsSync(localCodexAuthPath())) {
      return {
        id: 'executor:codex',
        engineId: 'codex',
        kind: 'codex',
        name: primary.name,
        model: defaultModel,
        enabled: true,
        configured: true,
        role: 'executor',
        roleLabel,
        usage: this.usageFor('executor:codex'),
        enabledEngines,
      };
    }
    if (primary.id === 'grok-build' && existsSync(localGrokAuthPath())) {
      return {
        id: 'executor:grok',
        engineId: 'grok-build',
        kind: 'grok',
        name: primary.name,
        model: defaultModel,
        enabled: true,
        configured: true,
        role: 'executor',
        roleLabel,
        usage: this.usageFor('executor:grok'),
        enabledEngines,
      };
    }
    if (primary.quota_script) {
      const usageId = `executor:${primary.id}`;
      return {
        id: usageId,
        engineId: primary.id,
        kind: primary.id,
        name: primary.name,
        model: defaultModel,
        enabled: true,
        configured: true,
        hasQuotaScript: true,
        role: 'executor',
        roleLabel,
        usage: this.usageFor(usageId),
        enabledEngines,
      };
    }
    return {
      id: `executor:${primary.id}`,
      engineId: primary.id,
      kind: primary.id,
      name: primary.name,
      model: defaultModel,
      enabled: true,
      configured: true,
      role: 'executor',
      roleLabel,
      usage: { status: 'unsupported', unsupported: true, source: primary.name },
      enabledEngines,
    };
  }
  summary() {
    try {
      const catalog = this.catalog(), activeId = catalog.activeId ?? null;
      const chatEntry = activeId ? this.publicEntry(this.requireConnection(catalog, activeId), activeId, catalog) : null;
      const chat = chatEntry || { name: '尚未选择模型', configured: false, usage: { status: 'unconfigured' } };
      return { activeId, chat, work: this.resolveWorkEngine(catalog) };
    } catch { return { activeId: null, chat: unavailable, work: null }; }
  }
  async cachedConnectionModels(entry, { fresh = false } = {}) {
    const now = Date.now();
    const cached = !fresh && this.connModelsCache.get(entry.id);
    if (cached && now - cached.at < 300_000) return cached.models;
    let models = [];
    try {
      const discovered = await Promise.race([
        this.choices(entry.id, entry.kind === 'api'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      models = discovered?.models || [];
    } catch {
      models = modelChoices(entry.kind, entry.provider);
    }
    if (entry.model && !models.some(m => m.id === entry.model)) {
      models = [{ id: entry.model, name: entry.model }, ...models];
    }
    const clean = models.map(({ id, name, thinkingLevels }) => ({ id, name: name || id, ...(thinkingLevels?.length ? { thinkingLevels } : {}) }));
    this.connModelsCache.set(entry.id, { at: now, models: clean });
    return clean;
  }
  async snapshot() {
    const catalog = this.catalog(), activeId = catalog.activeId;
    const connections = await Promise.all(catalog.connections.map(async entry => {
      const summary = this.publicEntry(entry, activeId, catalog);
      let ok = false;
      try {
        connectionModel(entry);
        ok = entry.allowNoKey === true ? true : Boolean(await this.credentials.read(entry.id));
      } catch { ok = false; }
      this.configured[entry.id] = ok;
      const availableModels = ok ? await this.cachedConnectionModels(entry).catch(() => []) : [];
      return { ...summary, configured: ok, availableModels };
    }));
    const summary = this.summary();
    const mapChoice = ({ id, name, contextWindow, maxTokens, thinkingLevels }) => ({ id, name, contextWindow, maxTokens, thinkingLevels });
    const enabledList = this.engines?.available?.() || [];
    const enabledEngines = await Promise.all(enabledList.map(async eng => {
      let discovered = { source: 'preset', models: [] };
      try { discovered = await this.engines.discoverModels(eng.id, { fresh: false }); } catch {}
      return {
        id: eng.id,
        name: eng.name,
        summary: eng.summary,
        installed: eng.installed,
        available: eng.available,
        tiers: this.engineTiersFor(catalog, eng.id),
        modelSource: discovered.source,
        models: discovered.models,
      };
    }));
    return {
      ...summary,
      chat: { ...summary.chat, configured: connections.some(entry => entry.active && entry.configured) },
      connections,
      roleRouting: catalog.roleRouting,
      engineRouting: catalog.engineRouting,
      enabledEngines,
      autoConfig: catalog.autoConfig,
      autoGrantPurposeConnections: catalog.autoGrantPurposeConnections,
      codexModels: modelChoices('codex', 'openai-codex').map(mapChoice),
      presets: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
        { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
        { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', api: 'openai-responses' },
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
        { id: 'openai-compatible', name: '其他 / 自定义地址', baseUrl: '', api: 'openai-completions' }].map(preset => ({ ...preset,
          models: modelChoices('api', preset.id).map(mapChoice) })),
    };
  }
  async saveRouting(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject('invalid_model_routing', '角色模型配置格式无效');
    await this.mutate(catalog => {
      if (input.autoGrantPurposeConnections !== undefined) {
        catalog.autoGrantPurposeConnections = input.autoGrantPurposeConnections !== false;
      }
      if (input.roleRouting !== undefined) {
        if (!input.roleRouting || typeof input.roleRouting !== 'object' || Array.isArray(input.roleRouting)) {
          reject('invalid_model_routing', '聊天角色路由格式无效');
        }
        for (const purpose of modelPurposes) {
          if (!Object.hasOwn(input.roleRouting, purpose)) continue;
          const slot = input.roleRouting[purpose];
          if (!slot) { catalog.roleRouting[purpose] = null; continue; }
          const connId = typeof slot.connection_id === 'string' ? slot.connection_id.trim() : '';
          const conn = this.requireConnection(catalog, connId);
          const modelId = typeof slot.model === 'string' ? slot.model.trim() : '';
          const thinking = slot.thinking_level === '' || slot.thinking_level === undefined ? null : slot.thinking_level;
          if (!validModelId(modelId)) reject('invalid_model_id', `角色 ${purpose} 需填写有效的模型 ID`);
          if (!validThinkingLevel(thinking)) reject('invalid_thinking_level', `角色 ${purpose} 的思考强度无效`);
          validateModelPurpose(conn, modelId, thinking, `roleRouting.${purpose}.thinking_level`);
          catalog.roleRouting[purpose] = { connection_id: conn.id, model: modelId, thinking_level: thinking };
        }
        if (catalog.roleRouting.conversation?.connection_id) {
          catalog.activeId = catalog.roleRouting.conversation.connection_id;
        }
      }
      if (input.engineRouting !== undefined) {
        if (!input.engineRouting || typeof input.engineRouting !== 'object' || Array.isArray(input.engineRouting)) {
          reject('invalid_model_routing', '工作引擎模型配置格式无效');
        }
        for (const [engineId, rawTiers] of Object.entries(input.engineRouting)) {
          if (!rawTiers || typeof rawTiers !== 'object' || Array.isArray(rawTiers)) continue;
          const cleaned = {};
          const defaults = defaultEngineTiers(engineId);
          for (const tier of engineTiers) {
            const item = rawTiers[tier];
            if (!item || typeof item !== 'object') continue;
            const modelId = typeof item.model === 'string' ? item.model.trim() : '';
            if (!modelId) continue;
            if (!validModelId(modelId)) reject('invalid_model_id', `引擎 ${engineId} 的 ${tier} 档模型 ID 无效`);
            const effort = item.effort === '' || item.effort === undefined || item.effort === null ? null : String(item.effort).trim().toLowerCase();
            if (effort !== null && !validThinkingLevel(effort)) reject('invalid_thinking_level', `引擎 ${engineId} 的 ${tier} 档思考深度无效`);
            const when = typeof item.when === 'string' && item.when.trim() ? item.when.trim().slice(0, 120) : (defaults[tier]?.when || '');
            cleaned[tier] = { model: modelId, effort, when };
          }
          if (!cleaned.standard) reject('invalid_model_routing', `引擎 ${engineId} 必须配置「常规默认档」模型`);
          catalog.engineRouting[engineId] = cleaned;
        }
      }
      catalog.autoConfig = {
        ...catalog.autoConfig,
        customized: input.markCustomized !== false,
        updatedAt: new Date().toISOString(),
        ...(input.markCustomized !== false ? { source: 'manual' } : {}),
      };
    });
    if (!this.closing) void this.refreshUsage(false).catch(() => {});
    return this.snapshot();
  }
  heuristicRecommend(chatInventory, engineInventory, catalog) {
    const pickChatModel = (conn, role) => {
      const models = conn.models || [];
      const ids = models.map(m => m.id);
      const findRe = re => models.find(m => re.test(m.id));
      let chosen = null;
      if (role === 'fast_read') {
        chosen = findRe(/flash|mini|haiku|terra|fast/i) || models.find(m => m.id === conn.currentModel) || models[0];
      } else if (role === 'pi_session') {
        chosen = findRe(/reasoner|sol|opus|pro|sonnet|flash|terra/i) || models.find(m => m.id === conn.currentModel) || models[0];
      } else {
        chosen = models.find(m => m.id === conn.currentModel) || findRe(/terra|sonnet|flash|chat|grok-4/i) || models[0];
      }
      const modelId = chosen?.id || conn.currentModel || ids[0] || '';
      const levels = chosen?.thinkingLevels || [];
      let thinking = null;
      if (role === 'fast_read') thinking = levels.includes('off') || !levels.length ? 'off' : null;
      else if (role === 'conversation') thinking = levels.includes('high') ? 'high' : (levels.includes('medium') ? 'medium' : (conn.thinkingLevel ?? null));
      else thinking = levels.includes('high') ? 'high' : (levels.includes('max') ? 'max' : null);
      return { connection_id: conn.id, model: modelId, thinking_level: thinking };
    };
    const activeConn = chatInventory.find(c => c.id === catalog.activeId) || chatInventory[0] || null;
    const fastConn = chatInventory.find(c => c.provider === 'deepseek' || c.models?.some(m => /flash|mini|haiku/i.test(m.id))) || activeConn;
    const roleRouting = {};
    if (activeConn) {
      roleRouting.fast_read = pickChatModel(fastConn || activeConn, 'fast_read');
      roleRouting.conversation = pickChatModel(activeConn, 'conversation');
      roleRouting.pi_session = pickChatModel(activeConn, 'pi_session');
    }
    const engineRouting = {};
    for (const eng of engineInventory) {
      const models = eng.models || [];
      const findRe = re => models.find(m => re.test(m.id));
      const effortOf = (m, fallback) => {
        const match = m?.id?.match(/-(low|medium|high|xhigh|max)$/i);
        if (match) return match[1].toLowerCase();
        if (m?.efforts?.includes(fallback)) return fallback;
        return m?.efforts?.[0] || fallback || null;
      };
      const preset = defaultEngineTiers(eng.id);
      let std = null, deep = null, fast = null;
      if (eng.id === 'agy') {
        std = findRe(/^gemini-4-hydrogen$/i) || findRe(/hydrogen|neon|sonnet/i) || models[0];
        deep = findRe(/^gemini-4-neon$/i) || findRe(/neon|opus/i) || std;
        fast = findRe(/^gemini-3\.8-flash$/i) || findRe(/flash/i) || std;
      } else if (eng.id === 'codex') {
        std = findRe(/gpt-6\.2-sol|sol/i) || findRe(/terra/i);
        deep = findRe(/gpt-6\.2-astra|astra/i) || std;
        fast = findRe(/terra|mini/i);
      } else if (eng.id === 'claude-code') {
        std = findRe(/sonnet/i);
        deep = findRe(/opus/i);
        fast = findRe(/haiku/i);
      } else {
        std = findRe(/high|medium|sonnet|sol|grok-4/i) || models[0];
        deep = findRe(/xhigh|max|opus|astra|pro/i);
        fast = findRe(/flash|mini|haiku|fast|low/i);
      }
      const tiers = {};
      if (std?.id || preset.standard?.model) {
        tiers.standard = {
          model: std?.id || preset.standard.model,
          effort: effortOf(std, preset.standard?.effort || 'high'),
          when: preset.standard?.when || '常规现场摸底、排障、脚本与中等修改（默认）',
        };
      }
      if (deep?.id || preset.deep?.model) {
        tiers.deep = {
          model: deep?.id || preset.deep.model,
          effort: effortOf(deep, preset.deep?.effort || 'xhigh'),
          when: preset.deep?.when || '复杂多文件开发、深度架构设计与疑难根因攻关',
        };
      }
      if (fast?.id || preset.fast?.model) {
        tiers.fast = {
          model: fast?.id || preset.fast.model,
          effort: effortOf(fast, preset.fast?.effort || 'low'),
          when: preset.fast?.when || '极速轻量采样、小脚本或简单文件整理',
        };
      }
      if (Object.keys(tiers).length) engineRouting[eng.id] = tiers;
    }
    return {
      roleRouting,
      engineRouting,
      rationale: '已根据当前已接入聊天模型与已启用工作引擎的实时目录完成分档匹配：快读关闭思考提速，群聊主脑保持高推理，工作引擎常规档兼顾速度与质量、深度档专攻复杂工程。',
    };
  }
  async autoRecommend({ apply = true, onlyMissingEngines = false, reason = 'manual' } = {}) {
    if (this.autoRecommendInFlight && reason !== 'manual') return this.autoRecommendInFlight;
    const task = (async () => {
      const catalog = this.catalog();
      await this.syncConfigured(catalog).catch(() => {});
      const configuredConns = catalog.connections.filter(c => this.isConfigured(c));
      const chatInventory = await Promise.all(configuredConns.map(async conn => {
        let models = [];
        try {
          const discovered = await Promise.race([
            this.choices(conn.id, conn.kind === 'api'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
          ]);
          models = discovered?.models || [];
        } catch {
          models = modelChoices(conn.kind, conn.provider);
        }
        if (!models.some(m => m.id === conn.model)) {
          models = [{ id: conn.model, name: conn.model }, ...models];
        }
        return {
          id: conn.id,
          name: conn.name,
          kind: conn.kind,
          provider: conn.provider,
          active: conn.id === catalog.activeId,
          currentModel: conn.model,
          thinkingLevel: conn.thinkingLevel ?? null,
          models: models.slice(0, 30).map(m => ({ id: m.id, name: m.name || m.id, ...(m.thinkingLevels?.length ? { thinkingLevels: m.thinkingLevels } : {}) })),
        };
      }));

      const enabledList = this.engines?.available?.({ fresh: reason === 'manual' }) || [];
      const engineInventory = await Promise.all(enabledList.map(async eng => {
        let discovered = { source: 'preset', models: [] };
        try { discovered = await this.engines.discoverModels(eng.id, { fresh: reason === 'manual' }); } catch {}
        return { id: eng.id, name: eng.name, summary: eng.summary, source: discovered.source, models: discovered.models.slice(0, 40) };
      }));

      const fallback = this.heuristicRecommend(chatInventory, engineInventory, catalog);
      let aiResult = null;
      let source = 'heuristic';

      const runnerConn = configuredConns.find(c => c.id === catalog.activeId) || configuredConns[0] || null;
      if (runnerConn && (chatInventory.length || engineInventory.length)) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('AI 自动配置超时')), 25_000);
        try {
          const model = connectionModel({ ...runnerConn, thinkingLevel: 'off' });
          const runtime = connectionRuntime(runnerConn, this.credentials, model);
          const resolved = await runtime.models.getAuth(runnerConn.id, { signal: controller.signal });
          if (resolved || runnerConn.allowNoKey) {
            const apiKey = resolved?.auth?.apiKey ?? 'no-key';
            const wireModel = { ...model, headers: { ...model.headers, ...grokProxyHeaders(runnerConn) } };
            const promptPayload = {
              chat_connections: chatInventory,
              enabled_work_engines: engineInventory,
            };
            const systemPrompt = [
              '你是 Summon Bot 的模型与工作引擎配置顾问。请根据用户当前**真实已接入的聊天连接**与**真实已启用的工作引擎**及其最新模型目录，为每个角色挑选最合理的模型与思考深度。',
              '硬规则：',
              '1. 只能从输入 JSON 提供的 connection_id 和 model id 中选择，严禁编造不存在的模型或连接。',
              '2. 聊天角色（roleRouting）：',
              '   - fast_read：高频快读路由，优先速度最快/成本最低的模型，thinking_level 设为 "off"（若支持）。',
              '   - conversation：群聊主脑，优先平衡对话理解、工具调用与缓存命中率，优先尊重当前 active 连接，thinking_level 建议 "high" 或 "medium"。',
              '   - pi_session：独立轻量 Pi 阅读会话，选稳定推理档（"high" 或 "max"）。',
              '3. 工作引擎分档（engineRouting，按每个已启用引擎的 id 分别配置）：',
              '   - standard（必填，默认档）：用于日常现场摸底、排障、脚本与常规改代码——**绝不要把最慢的 xhigh/max 档设为 standard**，优先选速度与能力兼顾的中高档（例如 AGY 选 gemini-4-hydrogen + effort "high"）。',
              '   - deep（可选）：用于复杂多文件工程、架构设计与疑难根因死磕，选最强思考档（例如 AGY 选 gemini-4-neon + effort "xhigh"，Codex 选 gpt-6.2-astra + effort "xhigh"）。',
              '   - fast（可选）：用于极速轻量采样/简单文件整理，选最快的 flash/mini/haiku/low 档（例如 AGY 选 gemini-3.8-flash + effort "low"）。',
              '   - 每个档位给一句 8–28 字简洁中文 when 说明适用场景。',
              '4. 仅输出一个合法 JSON 对象，不要输出任何额外解释或 markdown 围栏外文本，格式：',
              '{"roleRouting":{"fast_read":{"connection_id":"","model":"","thinking_level":"off"},"conversation":{"connection_id":"","model":"","thinking_level":"high"},"pi_session":{"connection_id":"","model":"","thinking_level":"high"}},"engineRouting":{"<engineId>":{"standard":{"model":"","effort":"","when":""},"deep":{"model":"","effort":"","when":""},"fast":{"model":"","effort":"","when":""}}},"rationale":"1-2句简洁中文说明分配理由"}',
            ].join('\n');
            const stream = runtime.models.streamSimple(wireModel, {
              systemPrompt,
              messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(promptPayload) }], timestamp: Date.now() }],
            }, {
              apiKey,
              maxTokens: 1400,
              signal: controller.signal,
              timeoutMs: 24_000,
              maxRetries: 0,
              ...(model.thinkingLevels?.includes('off') ? { reasoning: 'off' } : {}),
              ...(runnerConn.kind === 'codex' ? { transport: 'sse' } : {}),
            });
            let text = '';
            for await (const event of stream) {
              if (event?.type === 'text_delta' && typeof event.delta === 'string') text += event.delta;
              if (event?.type === 'done') break;
            }
            const trimmed = text.trim();
            const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed && typeof parsed === 'object') {
                aiResult = parsed;
                source = 'ai';
              }
            }
          }
        } catch {}
        finally { clearTimeout(timer); }
      }

      // Validate & merge AI output with deterministic fallback so nothing invalid ever slips in
      const connMap = new Map(chatInventory.map(c => [c.id, c]));
      const engMap = new Map(engineInventory.map(e => [e.id, e]));
      const nextRoleRouting = {};
      for (const purpose of modelPurposes) {
        const candidate = aiResult?.roleRouting?.[purpose];
        const fb = fallback.roleRouting[purpose] || null;
        if (candidate && typeof candidate === 'object' && connMap.has(candidate.connection_id) && typeof candidate.model === 'string' && candidate.model.trim()) {
          const connInfo = connMap.get(candidate.connection_id);
          const rawConn = catalog.connections.find(c => c.id === connInfo.id);
          const modelId = candidate.model.trim();
          const modelAllowed = connInfo.models.some(m => m.id === modelId);
          const thinking = candidate.thinking_level === '' || candidate.thinking_level === undefined ? null : candidate.thinking_level;
          if (modelAllowed && rawConn && validThinkingLevel(thinking)) {
            try {
              validateModelPurpose(rawConn, modelId, thinking);
              nextRoleRouting[purpose] = { connection_id: rawConn.id, model: modelId, thinking_level: thinking };
              continue;
            } catch {}
          }
        }
        nextRoleRouting[purpose] = fb;
      }

      const nextEngineRouting = {};
      for (const eng of engineInventory) {
        const aiEng = aiResult?.engineRouting?.[eng.id];
        const fbEng = fallback.engineRouting[eng.id] || {};
        const allowedIds = new Set(eng.models.map(m => m.id));
        const tiers = {};
        for (const tier of engineTiers) {
          const cand = aiEng?.[tier];
          const fb = fbEng[tier] || null;
          if (cand && typeof cand === 'object' && typeof cand.model === 'string' && allowedIds.has(cand.model.trim())) {
            const effort = cand.effort === '' || cand.effort === undefined || cand.effort === null ? null : String(cand.effort).trim().toLowerCase();
            tiers[tier] = {
              model: cand.model.trim(),
              effort: effort && validThinkingLevel(effort) ? effort : (fb?.effort ?? null),
              when: typeof cand.when === 'string' && cand.when.trim() ? cand.when.trim().slice(0, 120) : (fb?.when || ''),
            };
          } else if (fb) {
            tiers[tier] = fb;
          }
        }
        if (Object.keys(tiers).length) nextEngineRouting[eng.id] = tiers;
      }

      const rationale = typeof aiResult?.rationale === 'string' && aiResult.rationale.trim()
        ? aiResult.rationale.trim().slice(0, 600)
        : fallback.rationale;

      if (apply) {
        await this.mutate(cat => {
          if (!onlyMissingEngines) {
            for (const purpose of modelPurposes) {
              if (nextRoleRouting[purpose]) cat.roleRouting[purpose] = nextRoleRouting[purpose];
            }
            if (cat.roleRouting.conversation?.connection_id) {
              cat.activeId = cat.roleRouting.conversation.connection_id;
            }
          }
          for (const [engId, tiers] of Object.entries(nextEngineRouting)) {
            if (onlyMissingEngines && cat.engineRouting?.[engId]?.standard) continue;
            cat.engineRouting[engId] = tiers;
          }
          cat.autoConfig = {
            customized: onlyMissingEngines ? Boolean(cat.autoConfig?.customized) : false,
            updatedAt: new Date().toISOString(),
            source,
            rationale,
          };
        });
        if (!this.closing) void this.refreshUsage(false).catch(() => {});
      }

      const snap = await this.snapshot();
      return {
        ...snap,
        autoRecommendation: { source, rationale, applied: apply },
      };
    })();
    this.autoRecommendInFlight = task.finally(() => { if (this.autoRecommendInFlight === task) this.autoRecommendInFlight = null; });
    return this.autoRecommendInFlight;
  }
  ensureEngineRouting(engineId) {
    if (!engineId || this.closing) return;
    try {
      const cat = this.catalog();
      if (cat.engineRouting?.[engineId]?.standard) return;
    } catch { return; }
    void this.autoRecommend({ apply: true, onlyMissingEngines: true, reason: 'engine_enabled' }).catch(() => {});
  }
  async save(input) {
    if (!['api', 'codex', 'grok'].includes(input.kind)) throw new Error('请选择 Codex 订阅、Grok 订阅或通用 API');
    const id = input.id || `${input.kind}-${randomUUID()}`;
    if (!/^[A-Za-z0-9_:-]{1,200}$/.test(id)) throw new Error('无效的连接编号');
    if (input.apiKey !== undefined && input.apiKey !== '' && (input.kind !== 'api' || typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16000)) throw new Error('无效的 API Key');
    await this.mutate(catalog => {
      const previous = catalog.connections.find(item => item.id === id);
      if (previous && previous.kind !== input.kind) throw new Error('请为不同类型建立新的连接');
      const name = String(input.name || previous?.name || (input.kind === 'api' ? 'API' : input.kind === 'codex' ? 'Codex 订阅' : 'Grok 订阅')).trim().slice(0, 80);
      const entry = { ...previous, id, kind: input.kind, name, model: String(input.model || previous?.model || (input.kind === 'codex' ? 'gpt-6.1-terra' : input.kind === 'grok' ? 'grok-4.7' : '')).trim(),
        provider: input.kind === 'codex' ? 'openai-codex' : input.kind === 'grok' ? 'xai' : String(input.provider || previous?.provider || 'openai-compatible'),
        baseUrl: input.kind === 'codex' ? 'https://chatgpt.com/backend-api' : input.kind === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : String(input.baseUrl || previous?.baseUrl || '').trim().replace(/\/+$/, ''),
        api: input.kind === 'codex' ? 'openai-codex-responses' : input.kind === 'grok' ? 'openai-responses' : input.api || previous?.api || 'openai-completions',
        thinkingLevel: Object.hasOwn(input, 'thinkingLevel') ? input.thinkingLevel : previous?.thinkingLevel ?? null,
        allowNoKey: input.kind === 'api' && (input.allowNoKey ?? previous?.allowNoKey) === true,
        ...(input.kind === 'api' ? { balancePath: String(input.balancePath ?? previous?.balancePath ?? '').trim(), balanceField: String(input.balanceField ?? previous?.balanceField ?? '').trim(), balanceCurrency: String(input.balanceCurrency || previous?.balanceCurrency || 'USD').slice(0, 8) } : {}) };
      if (!validModelId(entry.model)) throw new Error('请填写有效的模型 ID');
      if (!validThinkingLevel(entry.thinkingLevel)) throw new Error('无效的思考强度');
      const endpoint = new URL(entry.baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('请填写不含凭据、查询参数的模型 API 地址');
      if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'openai-codex-responses'].includes(entry.api) || input.kind === 'api' && entry.api === 'openai-codex-responses') throw new Error('请选择有效的 API 协议');
      if (entry.balancePath && (!entry.balancePath.startsWith('/') || entry.balancePath.startsWith('//') || new URL(entry.balancePath, entry.baseUrl).origin !== endpoint.origin)) throw new Error('余额查询路径必须位于同一个 API 服务');
      for (const key of ['contextWindow', 'maxTokens']) {
        if (!Object.hasOwn(input, key)) continue;
        if (input[key] === null || input[key] === '') delete entry[key];
        else entry[key] = Number(input[key]);
      }
      validateModelPurpose(entry, entry.model, entry.thinkingLevel);
      if (previous) catalog.connections[catalog.connections.indexOf(previous)] = entry; else catalog.connections.push(entry);
      if (input.activate === true || (!catalog.activeId && entry.kind === 'api' && (input.apiKey || entry.allowNoKey))) {
        catalog.activeId = id;
      }
    }, input.apiKey ? { id, key: input.apiKey.trim() } : null, () => this.clearUsage(id));
    const afterCat = this.catalog();
    if (!this.closing && !afterCat.autoConfig?.customized && !afterCat.autoConfig?.updatedAt && afterCat.activeId) {
      void this.autoRecommend({ apply: true, reason: 'initial' }).catch(() => {});
    }
    if (!this.closing) void this.refreshUsage(false).catch(() => {});
    return { ...await this.snapshot(), savedId: id };
  }
  async select(id) {
    await this.mutate(catalog => {
      if (id !== null) this.requireConnection(catalog, id);
      catalog.activeId = id;
      if (id !== null) {
        const entry = catalog.connections.find(c => c.id === id);
        if (entry) {
          for (const purpose of modelPurposes) {
            const cur = catalog.roleRouting?.[purpose];
            if (!cur || !catalog.autoConfig?.customized || purpose === 'conversation') {
              const resolved = resolveConnectionPurpose(catalog, id, purpose);
              if (resolved) {
                catalog.roleRouting[purpose] = { connection_id: id, model: resolved.id, thinking_level: resolved.thinking_level };
              }
            }
          }
        }
      }
    });
    const afterCat = this.catalog();
    if (!this.closing && id && !afterCat.autoConfig?.customized) {
      void this.autoRecommend({ apply: true, reason: 'initial' }).catch(() => {});
    }
    if (!this.closing) void this.refreshUsage(false).catch(() => {});
    return this.snapshot();
  }
  async remove(id) {
    await this.mutate(catalog => {
      this.requireConnection(catalog, id);
      catalog.connections = catalog.connections.filter(entry => entry.id !== id);
      if (catalog.activeId === id) catalog.activeId = catalog.connections[0]?.id ?? null;
      for (const purpose of modelPurposes) {
        if (catalog.roleRouting?.[purpose]?.connection_id === id) {
          catalog.roleRouting[purpose] = null;
        }
      }
    }, null, () => {
      this.cancelLogin(id);
      this.clearUsage(id);
    });
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
  async importLocal(kind, { activate = false } = {}) {
    if (!['codex', 'grok'].includes(kind)) throw new Error('请选择 Codex 或 Grok');
    const name = kind === 'codex' ? 'Codex' : 'Grok', authMode = `${kind}-local`;
    const authFile = kind === 'codex' ? localCodexAuthPath() : localGrokAuthPath();
    let value; try { value = JSON.parse(await readFile(authFile, 'utf8')); } catch { throw new Error(`无法读取本机 ${name} 登录，请在这台机器上登录，或使用订阅授权`); }
    let identity, authScope;
    if (kind === 'codex') { const credential = codexCredential(value); identity = decodeModelToken(value.tokens.id_token || credential.access).email || '本机 Codex 账号'; }
    else { const login = localGrokLogin(value); identity = login.identity; authScope = login.authScope; }
    const existing = this.catalog().connections.find(entry => entry.authMode === authMode);
    const id = existing?.id || authMode;
    if (!existing) await this.save({ kind, id, name: `本机 ${name} 订阅` });
    await this.mutate(catalog => { const entry = requireEntry(catalog, id);
      entry.authMode = authMode; entry.authFile = authFile; entry.identity = identity;
      if (kind === 'grok') { entry.authScope = authScope; entry.baseUrl = 'https://cli-chat-proxy.grok.com/v1'; }
      if (activate || !catalog.activeId) catalog.activeId = id;
      this.clearUsage(id); });
    if (!this.closing) void this.refreshUsage(false).catch(() => {});
    return { ...await this.snapshot(), importedId: id };
  }
  async testConnection(id) {
    const connection = modelConnection({ connectionStore: this.path }, id);
    const model = connectionModel(connection);
    const runtime = connectionRuntime(connection, this.credentials);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('连接检测超时，请检查网络或代理设置')), 20000);
    try {
      const resolved = await runtime.models.getAuth(id, { signal: controller.signal });
      if (!resolved && !connection.allowNoKey) throw new Error('尚未完成授权或未填写 API Key');
      const apiKey = resolved?.auth?.apiKey ?? (connection.allowNoKey ? 'no-key' : '');
      const wireModel = { ...model, headers: { ...model.headers, ...grokProxyHeaders(connection) } };
      const context = {
        systemPrompt: 'Reply briefly with OK.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }], timestamp: Date.now() }],
      };
      const stream = runtime.models.streamSimple(wireModel, context, {
        apiKey,
        maxTokens: 16,
        signal: controller.signal,
        timeoutMs: 18000,
        maxRetries: 0,
        ...(connection.kind === 'codex' ? { transport: 'sse' } : {}),
      });
      let text = '';
      for await (const event of stream) {
        if (event?.type === 'text_delta' && typeof event.delta === 'string') text += event.delta;
        if (event?.type === 'error') {
          const msg = event.error?.errorMessage || event.error?.message || event.reason || '模型返回错误';
          throw new Error(msg);
        }
        if (event?.type === 'done') {
          if (event.message?.stopReason === 'error' || event.message?.errorMessage) {
            throw new Error(event.message.errorMessage || '模型调用失败');
          }
          break;
        }
      }
      return { ok: true, id, name: connection.name, model: model.id, latencyMs: Date.now() - started, preview: text.trim().slice(0, 40) || 'OK' };
    } catch (error) {
      const message = modelError(error) || error?.message || '模型连接检测失败';
      throw Object.assign(new Error(message), { status: 400, code: 'model_test_failed' });
    } finally {
      clearTimeout(timer);
    }
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
        this.clearUsage(id);
        await this.syncConfigured().catch(() => {});
        this.emit('models.changed', { id });
        if (!this.closing) void this.refreshUsage(false).catch(() => {});
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
    const hints = new Map(builtins.map(model => [model.id, model.thinkingLevels]));
    return { source: 'provider', models: entries.filter(entry => typeof entry?.id === 'string' || typeof entry?.slug === 'string').map(entry => {
      const id = entry.id || entry.slug;
      const levels = entry.thinkingLevels ?? entry.thinking_levels;
      return { id, name: entry.display_name || entry.name || id,
        thinkingLevels: Array.isArray(levels) ? levels.filter(level => typeof level === 'string' && validThinkingLevel(level)) : hints.get(id) };
    }) };
  }
  async fetchJson(url, headers, signal) {
    const timeout = AbortSignal.timeout(8000);
    const response = await fetch(url, { headers: { Accept: 'application/json', ...headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    if (!response.ok) throw new Error(`额度或目录查询返回 HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('供应商未返回有效的 JSON'); }
  }
  resolveUsageConnection(id) {
    if (id === 'executor:codex') {
      const connection = { id, kind: 'codex', name: 'Codex', provider: 'openai-codex', api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api', model: 'gpt-6.1-terra', authMode: 'codex-local', authFile: localCodexAuthPath() };
      return { connection, credentials: new ModelCredentialStore(null, connection) };
    }
    if (id === 'executor:grok') {
      const connection = { id, kind: 'grok', name: 'Grok', provider: 'xai', api: 'openai-responses',
        baseUrl: 'https://cli-chat-proxy.grok.com/v1', model: 'grok-4.7', authMode: 'grok-local', authFile: localGrokAuthPath() };
      return { connection, credentials: new ModelCredentialStore(null, connection) };
    }
    return { connection: modelConnection({ connectionStore: this.path }, id), credentials: this.credentials };
  }
  async accountUsage(id, signal) {
    if (id.startsWith('executor:') && !['executor:codex', 'executor:grok'].includes(id)) {
      const engineId = id.slice('executor:'.length);
      const engine = this.engines?.get?.(engineId);
      if (!engine?.quota_script) return { source: engine?.name || engineId, windows: [], unsupported: true };
      const scriptAbs = this.engines.scriptPath(engineId, engine.quota_script);
      const mod = await import(`${pathToFileURL(scriptAbs).href}?t=${Date.now()}`);
      if (typeof mod.readQuota !== 'function') return { source: engine.name, windows: [], unsupported: true };
      const tiers = this.engineTiers(engineId);
      const model = tiers.standard?.model || Object.values(tiers)[0]?.model || '';
      return await mod.readQuota({ engine, model, signal });
    }
    const { connection, credentials } = this.resolveUsageConnection(id);
    const runtime = connectionRuntime(connection, credentials);
    const resolved = await runtime.models.getAuth(id, { signal });
    signal.throwIfAborted();
    if (!resolved) throw new Error('尚未配置或授权');
    const key = resolved.auth.apiKey;
    if (connection.kind === 'codex') {
      const claims = decodeModelToken(key), accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
      const usage = await this.fetchJson('https://chatgpt.com/backend-api/wham/usage', { Authorization: `Bearer ${key}`, ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}) }, signal);
      const buckets = [{ name: 'Codex', limitId: 'codex', value: usage.rate_limit }, ...(usage.additional_rate_limits || []).map(value => ({ name: value.limit_name || value.metered_feature || '模型', limitId: value.limit_name || value.metered_feature || 'extra', value: value.rate_limit }))];
      const windows = buckets.flatMap(bucket => ['primary_window', 'secondary_window'].flatMap(field => {
        const value = bucket.value?.[field], used = number(value?.used_percent);
        if (!value || used === null) return [];
        return [{ name: `${bucket.name} · ${windowLabel(number(value.limit_window_seconds) / 60)}`, limitId: bucket.limitId, durationMinutes: number(value.limit_window_seconds) === null ? null : number(value.limit_window_seconds) / 60,
          remainingPercent: clamp(100 - used), resetsAt: date(value.reset_at) }];
      }));
      return { source: 'ChatGPT 订阅', plan: usage.plan_type || null, windows, credits: usage.credits?.has_credits ? number(usage.credits.balance) : null,
        unlimited: usage.credits?.unlimited === true, accountId };
    }
    if (connection.kind === 'grok') {
      const headers = { Authorization: `Bearer ${key}`, ...grokProxyHeaders(connection) };
      const [billing, settings] = await Promise.all([this.fetchJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', headers, signal),
        this.fetchJson('https://cli-chat-proxy.grok.com/v1/settings', headers, signal).catch(() => null)]);
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
      const result = await this.fetchJson('https://api.deepseek.com/user/balance', headers, signal);
      return { source: 'DeepSeek 余额', windows: [], balances: (result.balance_infos || []).flatMap(item => { const value = amount(item.total_balance, item.currency); return value ? [value] : []; }) };
    }
    if (connection.provider === 'openrouter' && new URL(connection.baseUrl).hostname === 'openrouter.ai') {
      const result = await this.fetchJson('https://openrouter.ai/api/v1/credits', headers, signal);
      const total = number(result.data?.total_credits), used = number(result.data?.total_usage);
      return { source: 'OpenRouter 余额', windows: [], balance: total !== null && used !== null ? amount(total - used, 'USD') : null };
    }
    if (connection.balancePath && connection.balanceField) {
      const result = await this.fetchJson(new URL(connection.balancePath, connection.baseUrl),
        connection.api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : headers, signal);
      const balance = amount(at(result, connection.balanceField), connection.balanceCurrency || 'USD');
      if (!balance) throw new Error('余额接口未返回指定的数值字段');
      return { source: '供应商余额接口', windows: [], balance };
    }
    return { source: 'API', windows: [], unsupported: true, note: '此服务未配置余额查询接口，可在设置中补充' };
  }
  refreshOne(id, force = false) {
    if (this.pendingUsage.has(id)) return this.pendingUsage.get(id).promise;
    const previous = this.usage[id];
    if (!force && Date.now() - Date.parse(previous?.attemptedAt || previous?.checkedAt) < 60000) return Promise.resolve(previous);
    const pending = { controller: new AbortController() };
    pending.promise = this.accountUsage(id, pending.controller.signal).then(value => ({
      ...value, status: value.unsupported ? 'unsupported' : 'ready', checkedAt: value.checkedAt || new Date().toISOString(),
    }), error => ({ ...previous, status: 'error', error: modelError(error), attemptedAt: new Date().toISOString(), stale: Boolean(previous?.checkedAt) }))
      .then(usage => {
        if (this.pendingUsage.get(id) !== pending) return null;
        this.pendingUsage.delete(id);
        if (pending.controller.signal.aborted) return null;
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
    await this.syncConfigured(catalog).catch(() => {});
    const ids = new Set();
    if (catalog.activeId) ids.add(catalog.activeId);
    const work = this.resolveWorkEngine(catalog);
    if (work?.id && (['executor:codex', 'executor:grok'].includes(work.id) || work.hasQuotaScript) && work.configured !== false) ids.add(work.id);
    if (!ids.size) return this.summary();
    await Promise.allSettled([...ids].map(id => this.refreshOne(id, force)));
    const commit = (this.usageWrite || Promise.resolve()).catch(() => {}).then(() => saveModelJson(this.usagePath, this.usage));
    this.usageWrite = commit;
    await commit.catch(() => {});
    return this.summary();
  }
  async close() {
    this.closing = true;
    clearTimeout(this.cleanupTimer);
    await this.cleanupTask;
    for (const id of this.logins.keys()) this.cancelLogin(id);
    await Promise.allSettled([...this.logins.values()].map(login => login.promise));
    await this.pauseUsage();
    await this.writeChain.catch(() => {});
  }
}
