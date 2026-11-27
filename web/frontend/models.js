'use strict';
globalThis.SummonModels = (() => {
  const view = {
    data: null,
    summary: null,
    editor: null,
    choices: [],
    connModelsCache: {},
    routingDraft: null,
    error: '',
    busy: false,
    autoRecommending: false,
    refreshingUsage: false,
    refreshingEngineId: null,
    login: null,
    loadedAt: 0,
    quotaId: null,
  };
  let bindings, loginTimer, usageTimer, loading, invalidateSidebar;
  const kinds = { codex: 'Codex 订阅', grok: 'Grok 订阅', api: '通用 API' };
  const roleMeta = [
    { key: 'fast_read', title: '快读' },
    { key: 'conversation', title: '主对话' },
    { key: 'pi_session', title: '独立 Pi' },
  ];
  const tierMeta = [
    { key: 'standard', title: '常规', required: true },
    { key: 'deep', title: '深度', required: false },
    { key: 'fast', title: '轻量', required: false },
  ];
  const commonThinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const effortOptions = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
  const thinkingChoices = (levels, current) => [...new Set(['off', ...(levels ?? commonThinkingLevels), current].filter(Boolean))];
  const thinkingLabel = level => level === 'off' ? '关闭' : level === '' ? '默认' : level;
  const formatMoney = balance => {
    if (!balance || !Number.isFinite(balance.amount)) return '';
    try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency || 'USD', maximumFractionDigits: 2 }).format(balance.amount); }
    catch { return `${balance.amount.toFixed(2)} ${balance.currency || ''}`; }
  };
  const resetTime = value => {
    const ms = Date.parse(value); if (!Number.isFinite(ms)) return '';
    const minutes = Math.ceil((ms - Date.now()) / 60000);
    if (minutes <= 0) return '等待更新';
    if (minutes < 60) return `${minutes} 分钟后重置`;
    if (minutes < 1440) return `${Math.ceil(minutes / 60)} 小时后重置`;
    return `${Math.ceil(minutes / 1440)} 天后重置`;
  };
  const balances = usage => [...(usage?.balances || []), ...(usage?.balance ? [usage.balance] : [])];
  const percents = usage => (usage?.windows || []).filter(item => typeof item.remainingPercent === 'number' && Number.isFinite(item.remainingPercent));

  function usageBody(usage, esc, compact = false) {
    if (usage?.status === 'not_connected') return `<small class="model-usage-note">${esc(usage.note || '未启用')}</small>`;
    if (usage?.status === 'unconfigured') return '<small class="model-usage-note">待配置</small>';
    if (usage?.status === 'connecting') return '<small class="model-usage-note">正在接入…</small>';
    if (!usage || usage.status === 'loading') return '<small class="model-usage-note">正在读取额度…</small>';
    if (usage.status === 'shared') return `<small class="model-usage-note">${esc(usage.note)}</small>`;
    const windows = percents(usage), money = balances(usage);
    const shown = compact ? windows.slice(0, 2) : windows;
    const credits = typeof usage?.credits === 'number' && Number.isFinite(usage.credits) ? usage.credits : null;
    const status = usage.status === 'error' ? (usage.stale ? '上次读取 · 暂未更新' : '暂时无法读取') : usage.unsupported ? '已连接 · 未提供额度接口' : !windows.length && !money.length && credits === null && !usage.unlimited ? '暂无额度数据' : '';
    return `${money.length ? `<div class="model-balances">${money.map(value => `<strong>${esc(formatMoney(value))}<small>余额</small></strong>`).join('')}</div>` : ''}
      ${shown.map(item => `<div class="model-quota-window"><div><span>${esc(item.name)}</span><strong>${Math.round(item.remainingPercent)}% <small>剩余</small></strong></div><span class="model-quota-track ${item.remainingPercent < 10 ? 'low' : ''}" role="meter" aria-label="${esc(item.name)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(item.remainingPercent)}"><i style="width:${Math.max(0, Math.min(100, item.remainingPercent))}%"></i></span>${!compact && item.resetsAt ? `<small>${esc(resetTime(item.resetsAt))} · ${esc(new Date(item.resetsAt).toLocaleString('zh-CN'))}</small>` : ''}</div>`).join('')}
      ${credits !== null && !compact ? `<span class="model-usage-note">附加点数 ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(credits)}</span>` : ''}
      ${usage?.unlimited ? '<span class="model-usage-note">额外额度不设限</span>' : ''}
      ${status ? `<small class="model-usage-note ${usage?.status === 'error' ? 'quota-warning' : ''}">${esc(status)}</small>` : ''}
      ${!compact && usage?.error ? `<p class="models-inline-error">${esc(usage.error)}</p>` : ''}
      ${!compact && usage?.checkedAt ? `<small class="model-usage-note">更新于 ${esc(new Date(usage.checkedAt).toLocaleString('zh-CN'))}</small>` : ''}`;
  }

  const duration = window => Number.isFinite(window.durationMinutes) ? window.durationMinutes
    : /每周|周额|week/i.test(window.name || '') ? 10080 : /(?:5\s*小时|5\s*hour)/i.test(window.name || '') ? 300 : null;

  function signal(item, esc) {
    const executor = item.role === 'executor';
    const awaiting = executor ? (item.enabled === false || item.configured === false) : item.configured === false;
    const usage = awaiting ? null : item.usage;
    const windows = percents(usage), money = balances(usage);
    const unsupported = !awaiting && Boolean(usage?.unsupported || usage?.status === 'unsupported');
    const loading = item.connecting || (!awaiting && !unsupported && (!usage || usage.status === 'loading'));
    const primaryPoolWindows = windows.filter(window => window.limitId === 'primary' || window.limitId === 'codex');
    const primaryWindows = primaryPoolWindows.length ? primaryPoolWindows : windows;
    const isApi = item.kind === 'api';
    const weekly = primaryWindows.find(window => duration(window) === 10080);
    const fiveHours = primaryWindows.find(window => duration(window) === 300);
    const main = weekly || primaryWindows[0] || null;
    const short = fiveHours && main !== fiveHours ? fiveHours : null;
    const balance = money.find(value => value.currency === 'CNY') || money[0] || null;
    const ring = awaiting || loading ? null : (isApi || unsupported) ? 100 : main?.remainingPercent ?? null;
    const dots = !loading && !isApi && !unsupported && short ? Math.ceil(Math.max(0, Math.min(100, short.remainingPercent)) / 25) : null;
    const percentage = main ? `${Math.round(Math.max(0, Math.min(100, main.remainingPercent)))}%` : '';
    let value = '';
    if (loading) value = item.connecting ? '配置中' : '读取中';
    else if (awaiting) value = item.label || (executor ? '未启用' : '待配置');
    else if (isApi) value = balance ? formatMoney(balance) : '暂无余额';
    else if (dots === null) value = percentage || (unsupported ? '已连接' : '暂无额度');

    const roleShort = executor ? (item.roleLabel || '工作引擎') : '聊天模型';
    const details = [roleShort, item.name];
    if (short) details.push(`5 小时剩余 ${Math.round(short.remainingPercent)}%`);
    if (main) details.push(`${main.name}剩余 ${Math.round(main.remainingPercent)}%`);
    else if (isApi && balance) details.push(`余额 ${formatMoney(balance)}`);
    else if (unsupported) details.push('已连接 · 未提供额度接口');
    const description = [...new Set(details.filter(Boolean))].join('\n');
    const low = isApi ? balance?.amount <= 0 : (!unsupported && (ring !== null && ring < 10 || short?.remainingPercent < 10));
    const points = [[21, 49], [28.5, 51.5], [35.5, 51.5], [43, 49]];
    const brand = loading ? '<i class="quota-signal-spinner" aria-hidden="true"></i>' : awaiting ? '' : globalThis.SummonModelIcons.svg(item);
    return `<button class="quota-signal ${executor ? 'executor' : ''} ${ring === null ? 'is-unknown' : ''} ${low ? 'is-low' : ''} ${usage?.status === 'error' ? 'is-stale' : ''}" data-action="models-quota" data-id="${esc(item.id || item.role)}" aria-label="${esc(description)}" aria-busy="${Boolean(loading)}" aria-expanded="${view.quotaId === (item.id || item.role)}" aria-controls="model-quota-popover">
      <span class="quota-signal-visual"><svg class="quota-signal-face" viewBox="0 0 64 59" aria-hidden="true" focusable="false"><path class="quota-signal-track" d="M15.74 45.26 A23 23 0 1 1 48.26 45.26" pathLength="100"/><path class="quota-signal-progress" d="M15.74 45.26 A23 23 0 1 1 48.26 45.26" pathLength="100" stroke-dasharray="${ring === null ? 0 : Math.max(0, Math.min(100, ring))} 100"/>
        ${dots === null ? '' : points.map(([x, y], index) => `<circle class="quota-signal-dot ${index < dots ? 'on' : ''}" cx="${x}" cy="${y}" r="1.9"/>`).join('')}</svg><span class="quota-signal-brand">${brand}</span>${value ? `<span class="quota-signal-value ${balance && !loading ? 'is-money' : ''}" aria-hidden="true">${esc(value)}</span>` : ''}</span>
      <span class="quota-signal-role">${esc(roleShort)}</span></button>`;
  }

  function sidebar({ esc, icon, invalidate }) {
    invalidateSidebar = invalidate;
    const current = view.summary;
    const active = current?.chat;
    const work = current?.work;
    const rows = [];
    if (active && current.activeId) rows.push({ ...active, role: 'model' });
    if (work) rows.push({ ...work, role: 'executor' });
    if (!rows.length) return '';
    const selected = rows.find(item => (item.id || item.role) === view.quotaId);
    const popoverEyebrow = selected?.role === 'executor' ? '工作引擎' : '聊天模型';
    const otherEngines = selected?.role === 'executor' && Array.isArray(selected.enabledEngines) && selected.enabledEngines.length > 1
      ? `<small class="model-usage-note">已启用：${esc(selected.enabledEngines.map(e => e.shortLabel).join(' · '))}</small>`
      : '';
    const popover = selected ? `<aside class="quota-popover" id="model-quota-popover" role="dialog" aria-label="${esc(selected.name || '模型')}额度"><header><span class="quota-popover-icon">${globalThis.SummonModelIcons.svg(selected, 28)}</span><div><small>${esc(popoverEyebrow)}</small><strong>${esc(selected.name || '正在读取')}</strong></div><button class="icon-button" data-action="models-quota-close" aria-label="关闭">${icon('close', 16)}</button></header>${selected.identity ? `<p class="quota-popover-model">${esc(selected.identity)}</p>` : ''}<div class="quota-popover-usage">${usageBody(selected.usage, esc)}${otherEngines}</div><footer><button data-action="open-settings" data-tab="models">模型设置 ${icon('arrow', 14)}</button></footer></aside>` : '';
    return `<section class="sidebar-models" aria-label="模型与工作引擎额度">${rows.map(item => signal(item, esc)).join('')}${popover}</section>`;
  }

  function closeQuota() {
    view.quotaId = null; document.querySelector('.quota-popover')?.remove();
    for (const button of document.querySelectorAll('[data-action="models-quota"]')) button.setAttribute('aria-expanded', 'false');
    invalidateSidebar?.();
  }

  const defaults = kind => ({
    kind,
    name: kinds[kind],
    model: kind === 'codex' ? 'gpt-6.1-terra' : kind === 'grok' ? 'grok-4.7' : '',
    provider: kind === 'api' ? 'openai-compatible' : kind === 'grok' ? 'xai' : 'openai-codex',
    api: kind === 'api' ? 'openai-completions' : 'openai-responses',
    baseUrl: '',
    thinkingLevel: null,
    apiKey: '',
  });

  function selectedEditor(data) {
    const entry = data.connections.find(item => item.id === data.activeId) ?? data.connections[0];
    return entry ? { ...entry, apiKey: '' } : null;
  }

  function modelsForConnection(data, connId) {
    const conn = (data?.connections || []).find(c => c.id === connId);
    if (!conn) return [];
    const live = view.connModelsCache[connId] || conn.availableModels || [];
    const catalog = conn.kind === 'codex'
      ? (data.codexModels || [])
      : (data.presets?.find(p => p.id === conn.provider)?.models || []);
    const byId = new Map();
    for (const m of catalog) byId.set(m.id, { ...m });
    for (const m of live) {
      const prev = byId.get(m.id);
      byId.set(m.id, {
        id: m.id,
        name: m.name || prev?.name || m.id,
        thinkingLevels: m.thinkingLevels?.length ? m.thinkingLevels : prev?.thinkingLevels,
      });
    }
    if (conn.model && !byId.has(conn.model)) {
      byId.set(conn.model, { id: conn.model, name: conn.model, thinkingLevels: conn.thinkingLevels });
    }
    return [...byId.values()];
  }

  function thinkingForRole(data, connId, modelId, current) {
    const list = modelsForConnection(data, connId);
    const matched = list.find(m => m.id === modelId);
    const conn = (data?.connections || []).find(c => c.id === connId);
    const levels = matched?.thinkingLevels || (modelId === conn?.model ? conn?.thinkingLevels : null) || ['off', ...commonThinkingLevels];
    return [...new Set([...levels, current].filter(v => v !== undefined && v !== null && v !== ''))];
  }

  function syncRoutingDraft(data) {
    const configured = (data?.connections || []).filter(c => c.configured === true);
    const defaultConn = configured.find(c => c.id === data?.activeId) || configured[0] || null;
    const roles = {};
    for (const { key } of roleMeta) {
      const saved = data?.roleRouting?.[key];
      const conn = configured.find(c => c.id === saved?.connection_id) || defaultConn;
      roles[key] = conn ? {
        connection_id: conn.id,
        model: saved?.connection_id === conn.id && saved?.model ? saved.model : conn.model,
        thinking_level: saved?.connection_id === conn.id && saved?.thinking_level !== undefined ? (saved.thinking_level ?? '') : (key === 'fast_read' ? 'off' : 'high'),
      } : { connection_id: '', model: '', thinking_level: '' };
    }
    const engines = {};
    for (const eng of (data?.enabledEngines || [])) {
      const savedTiers = eng.tiers || {};
      engines[eng.id] = {};
      for (const { key } of tierMeta) {
        const t = savedTiers[key];
        engines[eng.id][key] = {
          model: t?.model || '',
          effort: t?.effort || '',
          when: t?.when || '',
        };
      }
    }
    view.routingDraft = {
      roles,
      engines,
      autoGrantPurposeConnections: data?.autoGrantPurposeConnections !== false,
    };
  }

  function modelChoices(data, editor) {
    if (editor?.kind === 'codex') {
      return [...new Map([...(data.codexModels || []), ...view.choices].map(item => [item.id, item])).values()];
    }
    const preset = data.presets.find(item => item.id === editor?.provider);
    const savedConn = editor?.id ? data.connections.find(c => c.id === editor.id) : null;
    return [...new Map([...(preset?.models || []), ...(savedConn?.availableModels || []), ...view.choices].map(item => [item.id, item])).values()];
  }

  function editorThinkingChoices(choices, editor, selected) {
    const levels = choices.find(item => item.id === editor?.model)?.thinkingLevels
      ?? (editor?.model === selected?.model ? selected?.thinkingLevels : undefined);
    return thinkingChoices(levels, editor?.thinkingLevel);
  }

  function start(provided) {
    bindings = provided;
    if (!usageTimer) {
      usageTimer = setInterval(() => { if (!document.hidden) void updateUsage(false); }, 60000);
      void updateUsage(false);
    }
  }

  async function load(api, render, toast, refresh) {
    start({ api, render, toast, refresh });
    if (view.data && Date.now() - view.loadedAt < 15000) return;
    if (loading) return loading;
    loading = api('/api/model-settings').then(data => {
      view.data = data; view.loadedAt = Date.now(); view.summary = data; view.error = '';
      syncRoutingDraft(data);
      if (!view.editor) view.editor = selectedEditor(data);
    }).catch(error => { view.error = error.message; }).finally(() => { loading = null; });
    return loading;
  }

  function render({ esc, icon, embedded = false }) {
    if (!view.data) return `<div class="${embedded ? 'models-embedded' : 'page models-page'}">${embedded ? '' : '<h1>模型</h1>'}<p class="subtle">${esc(view.error || '正在读取…')}</p><button class="secondary-button small-button" data-action="models-reload">重试</button></div>`;
    const data = view.data, editor = view.editor, active = data.connections.find(item => item.id === data.activeId), summary = view.summary || data;
    if (!view.routingDraft) syncRoutingDraft(data);
    const configuredConns = (data.connections || []).filter(c => c.configured === true);
    const enabledEngines = data.enabledEngines || [];

    const input = (label, name, value, options = {}) => `<label class="models-field"><span>${label}</span><input name="${name}" ${options.type ? `type="${options.type}"` : ''} value="${esc(value ?? '')}" ${options.required ? 'required' : ''} ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''} ${options.list ? `list="${options.list}"` : ''} ${options.type === 'password' ? 'autocomplete="new-password"' : ''} ${options.type === 'number' ? 'min="128" step="1"' : ''}></label>`;
    const select = (label, name, values, current) => `<label class="models-field"><span>${label}</span><select name="${name}">${values.map(([value, title]) => `<option value="${esc(value)}" ${current === value ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;

    const selected = editor?.id ? data.connections.find(item => item.id === editor.id) : null;
    const defaultAction = selected ? `<button class="secondary-button" type="button"
      data-action="${selected.active ? 'models-deactivate' : 'models-activate'}" data-id="${esc(selected.id)}"
      ${view.busy ? 'disabled' : ''}>${selected.active ? '取消默认' : '设为默认'}</button>` : '';
    const choices = modelChoices(data, editor);
    const thinkingHints = editorThinkingChoices(choices, editor, selected);
    const login = view.login?.id === editor?.id ? view.login : null;
    const waiting = login && ['starting', 'waiting'].includes(login.status);
    const localLogin = ['codex-local', 'grok-local'].includes(editor?.authMode), localBrand = editor?.kind === 'codex' ? 'Codex' : 'Grok';
    const authorization = editor && editor.kind !== 'api' ? `<div class="models-auth-panel"><div><strong>${selected?.configured ? '已连接' : '授权订阅'}</strong>${localLogin ? `<p>本机 ${localBrand} 登录</p>` : ''}</div>${!selected ? `<button type="button" class="secondary-button" data-action="models-import-${esc(editor.kind)}">导入本机 ${localBrand}</button>` : ''}${selected && !localLogin ? `<button type="button" class="secondary-button" data-action="models-login" data-id="${esc(editor.id)}" ${waiting || view.busy ? 'disabled' : ''}>${selected.configured ? '重新授权' : '授权'}</button>` : ''}
      ${waiting ? `<div class="models-device-code"><span>${login.status === 'starting' ? '获取授权码…' : '输入授权码'}</span>${login.userCode ? `<strong>${esc(login.userCode)}</strong>` : ''}${login.verificationUri ? `<a class="primary-button" href="${esc(login.verificationUri)}" target="_blank" rel="noopener noreferrer">打开授权页 ${icon('link', 14)}</a>` : ''}<button type="button" class="text-button" data-action="models-cancel-login" data-id="${esc(editor.id)}">取消</button></div>` : ''}${login?.error ? `<p class="models-inline-error">${esc(login.error)}</p>` : ''}</div>` : '';

    // Overview cards: ONLY connection/engine name + quota/balance (zero duplicate tiers, zero session counts)
    const work = summary.work;
    const workCard = work ? `<section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot executor"></span><h2>工作引擎</h2><span>${esc(work.roleLabel || '')}</span></div><strong>${esc(work.name || '未启用')}</strong>${work.configured === false ? '<small class="model-usage-note">未启用</small>' : usageBody(work.usage, esc)}</section>` : '';

    // Chat role rows: real <select> for connection, model, and thinking level
    const chatRoleRows = configuredConns.length ? roleMeta.map(({ key, title }) => {
      const draft = view.routingDraft.roles[key] || { connection_id: '', model: '', thinking_level: '' };
      const connModels = modelsForConnection(data, draft.connection_id);
      const modelOptions = connModels.some(m => m.id === draft.model) || !draft.model
        ? connModels
        : [{ id: draft.model, name: draft.model }, ...connModels];
      const thinkingOpts = thinkingForRole(data, draft.connection_id, draft.model, draft.thinking_level);
      return `<div class="models-role-row">
        <span class="models-role-label">${esc(title)}</span>
        <div class="models-role-controls">
          <select data-role-key="${key}" data-role-field="connection_id" aria-label="${esc(title)}连接">${configuredConns.map(c => `<option value="${esc(c.id)}" ${draft.connection_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <select data-role-key="${key}" data-role-field="model" aria-label="${esc(title)}模型">${modelOptions.map(m => `<option value="${esc(m.id)}" ${draft.model === m.id ? 'selected' : ''}>${esc(m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id)}</option>`).join('')}</select>
          <select data-role-key="${key}" data-role-field="thinking_level" aria-label="${esc(title)}思考深度"><option value="" ${!draft.thinking_level ? 'selected' : ''}>默认</option>${thinkingOpts.map(lv => `<option value="${esc(lv)}" ${draft.thinking_level === lv ? 'selected' : ''}>${esc(thinkingLabel(lv))}</option>`).join('')}</select>
        </div>
      </div>`;
    }).join('') : '<p class="models-empty-note">请先在下方接入聊天连接</p>';

    // Work engine blocks: ONLY enabled engines, real <select> for model & effort
    const engineBlocks = enabledEngines.length ? enabledEngines.map(eng => {
      const engDraft = view.routingDraft.engines[eng.id] || {};
      const isRefreshing = view.refreshingEngineId === eng.id;
      const baseModels = eng.models || [];
      return `<div class="models-engine-role-block">
        <div class="models-engine-role-head">
          <span class="models-provider-monogram">${globalThis.SummonModelIcons.svg({ role: 'executor', id: eng.id, kind: eng.id }, 18)}</span>
          <strong>${esc(eng.name)}</strong>
          <button type="button" class="text-button" data-action="models-refresh-engine-models" data-id="${esc(eng.id)}" ${isRefreshing || view.busy ? 'disabled' : ''}>${icon('refresh', 13)} ${isRefreshing ? '刷新中…' : '刷新列表'}</button>
        </div>
        ${tierMeta.map(({ key, title, required }) => {
          const td = engDraft[key] || { model: '', effort: '' };
          const opts = baseModels.some(m => m.id === td.model) || !td.model
            ? baseModels
            : [{ id: td.model, name: td.model }, ...baseModels];
          const matchedModel = opts.find(m => m.id === td.model);
          const hasExplicitEfforts = Array.isArray(matchedModel?.efforts);
          const availEfforts = !td.model
            ? ['']
            : hasExplicitEfforts
              ? (matchedModel.efforts.length ? [...new Set([...matchedModel.efforts, td.effort].filter(Boolean))] : [''])
              : effortOptions;
          const effortDisabled = !td.model || (hasExplicitEfforts && !matchedModel.efforts.length);
          return `<div class="models-tier-row">
            <span class="models-role-label">${esc(title)}</span>
            <div class="models-tier-controls">
              <select data-eng-id="${esc(eng.id)}" data-eng-tier="${key}" data-eng-field="model" aria-label="${esc(eng.name)}${esc(title)}模型">${required ? '' : `<option value="" ${!td.model ? 'selected' : ''}>不启用</option>`}${opts.map(m => `<option value="${esc(m.id)}" ${td.model === m.id ? 'selected' : ''}>${esc(m.name && m.name !== m.id ? m.name : m.id)}</option>`).join('')}</select>
              <select data-eng-id="${esc(eng.id)}" data-eng-tier="${key}" data-eng-field="effort" aria-label="${esc(title)}思考深度" ${effortDisabled ? 'disabled' : ''}>${availEfforts.map(lv => `<option value="${esc(lv)}" ${td.effort === lv ? 'selected' : ''}>${lv || '默认'}</option>`).join('')}</select>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('') : '<p class="models-empty-note">暂未启用工作引擎</p>';

    const routingSection = `<section class="models-purpose-card">
      <div class="models-section-heading">
        <h2>模型分配</h2>
        <button type="button" class="primary-button" data-action="models-auto-recommend" ${view.busy || view.autoRecommending || (!configuredConns.length && !enabledEngines.length) ? 'disabled' : ''}>${view.autoRecommending ? 'AI 分析中…' : '✨ AI 自动填写'}</button>
      </div>
      <form id="model-routing-form">
        <h3 class="models-subhead">聊天</h3>
        <div class="models-role-list">${chatRoleRows}</div>
        <h3 class="models-subhead">工作引擎</h3>
        <div class="models-engine-role-list">${engineBlocks}</div>
        <div class="models-form-actions"><button class="secondary-button" type="submit" ${view.busy || view.autoRecommending ? 'disabled' : ''}>${view.busy ? '保存中…' : '保存'}</button></div>
      </form>
    </section>`;

    const form = editor ? `<section class="models-editor"><div class="models-section-heading"><h2>${editor.id ? esc(editor.name) : '添加连接'}</h2>${selected?.active ? '<span class="model-active-badge">当前默认</span>' : ''}</div>
      <form id="model-connection-form"><input type="hidden" name="kind" value="${esc(editor.kind)}">${input('名称', 'name', editor.name)}
      ${editor.kind === 'api' ? `${input('服务商 ID', 'provider', editor.provider)}${select('预设', 'preset', [['', '选择预设'], ...data.presets.map(item => [item.id, item.name])], '')}${select('协议', 'api', [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']], editor.api)}${input('API 地址', 'baseUrl', editor.baseUrl, { required: true, type: 'url', placeholder: 'https://api.example.com/v1' })}${input('API Key', 'apiKey', editor.apiKey, { type: 'password', placeholder: selected?.configured ? '已保存，留空不变' : '输入 API Key' })}<label class="models-checkbox"><input name="allowNoKey" type="checkbox" ${editor.allowNoKey ? 'checked' : ''}>无需 API Key</label>` : authorization}
      <div class="models-field-heading"><span>模型</span>${selected ? `<button type="button" class="text-button" data-action="models-discover" data-id="${esc(selected.id)}">拉取目录</button>` : ''}</div>
      <input class="models-model-input" name="model" list="models-choices" value="${esc(editor.model)}" placeholder="模型 ID" ${editor.kind === 'api' ? 'required' : ''}><datalist id="models-choices">${choices.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')}</datalist>
      ${input('思考深度', 'thinkingLevel', editor.thinkingLevel, { placeholder: '默认', list: 'models-thinking-levels' })}
      <datalist id="models-thinking-levels">${thinkingHints.map(level => `<option value="${esc(level)}">${level === 'off' ? '关闭' : esc(level)}</option>`).join('')}</datalist>
      <details class="models-advanced"><summary>上下文与余额接口</summary><div class="models-form-grid">${input('上下文 Token', 'contextWindow', editor.contextWindow, { type: 'number', placeholder: '默认' })}${input('输出 Token', 'maxTokens', editor.maxTokens, { type: 'number', placeholder: '默认' })}</div>${editor.kind === 'api' ? `${input('余额路径', 'balancePath', editor.balancePath, { placeholder: '/account/balance' })}<div class="models-form-grid">${input('余额字段', 'balanceField', editor.balanceField, { placeholder: 'data.balance' })}${input('币种', 'balanceCurrency', editor.balanceCurrency || 'USD', { placeholder: 'USD' })}</div>` : ''}</details>
      <div class="models-form-actions"><button class="primary-button" type="submit" ${view.busy ? 'disabled' : ''}>${view.busy ? '保存中…' : editor.kind === 'api' || selected?.configured ? '保存' : '保存并授权'}</button>${defaultAction}${selected && !selected.active ? `<button class="text-button models-remove" type="button" data-action="models-remove" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>移除</button>` : ''}</div></form></section>` : '';

    return `<div class="${embedded ? 'models-embedded' : 'page models-page'}">${embedded ? `<div class="settings-inline-toolbar"><span></span><button type="button" class="secondary-button small-button" data-action="models-refresh-usage" ${view.busy || view.refreshingUsage ? 'disabled' : ''}>${icon('refresh', 14)}${view.refreshingUsage ? '刷新中…' : '刷新额度'}</button></div>` : `${globalThis.SummonPageNav?.('models') || ''}<header class="models-header"><h1>模型</h1><button class="secondary-button" data-action="models-refresh-usage" ${view.busy || view.refreshingUsage ? 'disabled' : ''}>${icon('refresh', 15)}${view.refreshingUsage ? '刷新中…' : '刷新额度'}</button></header>`}
      ${view.error ? `<p class="models-inline-error" role="alert">${esc(view.error)}</p>` : ''}
      <div class="models-engine-overview"><section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot"></span><h2>聊天模型</h2><span>${esc(kinds[active?.kind] || '')}</span></div><strong>${esc(active?.name || '未连接')}</strong>${active?.configured === false ? '<small class="model-usage-note">待连接</small>' : usageBody(summary.chat?.usage, esc)}</section>${workCard}</div>
      ${routingSection}
      <div class="models-configuration"><section class="models-connections"><div class="models-section-heading"><h2>连接</h2><span>${data.connections.length}</span></div><div class="models-add-types">${Object.entries(kinds).map(([kind, label]) => `<button data-action="models-new" data-kind="${kind}" ${view.busy ? 'disabled' : ''}>${icon('plus', 14)}${label}</button>`).join('')}</div><div class="models-connection-list">${data.connections.map(item => `<button class="models-connection ${editor?.id === item.id ? 'selected' : ''}" data-action="models-edit" data-id="${esc(item.id)}"><span class="models-provider-monogram ${item.kind}">${globalThis.SummonModelIcons.svg(item, 22)}</span><span><strong>${esc(item.name)}</strong><small>${esc(kinds[item.kind])}${item.identity ? ` · ${esc(item.identity)}` : ''}</small></span>${item.configured === false ? '<small class="models-unconfigured">待连接</small>' : ''}${item.active ? '<i class="models-selected-dot" role="img" aria-label="默认" title="默认"></i>' : ''}</button>`).join('')}</div></section>${form}</div></div>`;
  }

  async function updateUsage(force) {
    if (!bindings) return;
    if (force) { view.refreshingUsage = true; bindings.render(); }
    try {
      const summary = await bindings.api('/api/model-settings/usage', 'POST', { force });
      view.summary = summary;
      invalidateSidebar?.();
      bindings.render();
    } catch (error) { if (force) bindings.toast(error.message, true); }
    finally {
      if (force) { view.refreshingUsage = false; bindings.render(); }
    }
  }

  async function fetchChoices(id, discover = false) {
    const value = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/models${discover ? '?discover=1' : ''}`);
    const list = value.models || [];
    view.connModelsCache[id] = list;
    if (view.editor?.id === id) view.choices = list;
  }

  async function pollLogin(id) {
    clearTimeout(loginTimer);
    try {
      view.login = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/login`);
      if (['starting', 'waiting'].includes(view.login.status)) loginTimer = setTimeout(() => { void pollLogin(id); }, 2000);
      if (view.login.status === 'completed') {
        view.data = await bindings.api('/api/model-settings'); view.summary = view.data;
        syncRoutingDraft(view.data);
        if (view.editor?.id === id) view.editor = { ...view.data.connections.find(item => item.id === id), apiKey: '' };
        bindings.toast('订阅已连接');
      }
      bindings.render();
    } catch (error) { view.error = error.message; bindings.render(); }
  }

  async function beginLogin(id) {
    view.login = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/login`, 'POST', {});
    bindings.render(); void pollLogin(id);
  }

  async function submit(form) {
    if (view.busy) return;
    const payload = { ...view.editor, ...Object.fromEntries(new FormData(form)), allowNoKey: form.elements.allowNoKey?.checked === true };
    delete payload.preset;
    delete payload.thinkingLevels;
    delete payload.effectivePurposes;
    delete payload.effectiveBudget;
    delete payload.availableModels;
    payload.thinkingLevel = payload.thinkingLevel.trim() || null;
    const previousIds = new Set(view.data.connections.map(item => item.id));
    view.busy = true; view.error = ''; bindings.render();
    try {
      view.data = await bindings.api('/api/model-settings/connections', 'POST', payload);
      syncRoutingDraft(view.data);
      const entry = view.data.connections.find(item => payload.id ? item.id === payload.id : !previousIds.has(item.id));
      view.editor = { ...entry, apiKey: '' }; view.summary = view.data;
      if (entry.kind !== 'api' && !entry.configured) await beginLogin(entry.id);
      else bindings.toast('已保存');
      await bindings.refresh?.();
    } catch (error) { view.error = error.message; bindings.toast(error.message, true); }
    finally { view.busy = false; bindings.render(); }
  }

  async function submitRouting() {
    if (view.busy || !view.routingDraft) return;
    view.busy = true; view.error = ''; bindings.render();
    try {
      const roleRouting = {};
      for (const { key } of roleMeta) {
        const slot = view.routingDraft.roles[key];
        if (slot?.connection_id && slot?.model?.trim()) {
          roleRouting[key] = {
            connection_id: slot.connection_id,
            model: slot.model.trim(),
            thinking_level: slot.thinking_level?.trim() || null,
          };
        }
      }
      const engineRouting = {};
      for (const [engId, tiers] of Object.entries(view.routingDraft.engines || {})) {
        const packed = {};
        for (const { key } of tierMeta) {
          const t = tiers[key];
          if (t?.model?.trim()) {
            packed[key] = {
              model: t.model.trim(),
              effort: t.effort?.trim() || null,
              when: t.when?.trim() || '',
            };
          }
        }
        if (Object.keys(packed).length) engineRouting[engId] = packed;
      }
      view.data = await bindings.api('/api/model-settings/routing', 'POST', {
        roleRouting,
        engineRouting,
        autoGrantPurposeConnections: view.routingDraft.autoGrantPurposeConnections !== false,
      });
      view.summary = view.data;
      syncRoutingDraft(view.data);
      invalidateSidebar?.();
      bindings.toast('已保存');
      await bindings.refresh?.();
    } catch (error) { view.error = error.message; bindings.toast(error.message, true); }
    finally { view.busy = false; bindings.render(); }
  }

  async function runAutoRecommend() {
    if (view.busy || view.autoRecommending) return;
    view.autoRecommending = true; view.error = ''; bindings.render();
    try {
      const result = await bindings.api('/api/model-settings/auto-recommend', 'POST', { apply: true });
      view.data = result;
      view.summary = result;
      syncRoutingDraft(result);
      invalidateSidebar?.();
      bindings.toast(result.autoRecommendation?.rationale || 'AI 已自动填写');
      await bindings.refresh?.();
    } catch (error) { view.error = error.message; bindings.toast(error.message, true); }
    finally { view.autoRecommending = false; bindings.render(); }
  }

  async function refreshEngineModels(engineId) {
    if (!engineId || view.refreshingEngineId) return;
    view.refreshingEngineId = engineId; bindings.render();
    try {
      const res = await bindings.api(`/api/engines/${encodeURIComponent(engineId)}/models?fresh=1`);
      const target = (view.data?.enabledEngines || []).find(e => e.id === engineId);
      if (target && Array.isArray(res?.models)) target.models = res.models;
      bindings.toast(`已刷新（${res?.models?.length || 0} 个模型）`);
    } catch (error) { bindings.toast(error.message, true); }
    finally { view.refreshingEngineId = null; bindings.render(); }
  }

  async function act(action, element, provided) {
    bindings = provided;
    if (action === 'models-quota') { view.quotaId = view.quotaId === element.dataset.id ? null : element.dataset.id; return provided.render(); }
    if (action === 'models-quota-close') return closeQuota();
    if (action === 'models-refresh-usage') return updateUsage(true);
    if (action === 'models-auto-recommend') return runAutoRecommend();
    if (action === 'models-refresh-engine-models') return refreshEngineModels(element.dataset.id);
    if (action === 'models-reload') { view.loadedAt = 0; await load(provided.api, provided.render, provided.toast, provided.refresh); return provided.render(); }
    if (view.busy) return;
    try {
      view.error = '';
      if (!view.data) await load(provided.api, provided.render, provided.toast, provided.refresh);
      if (action === 'models-new') { view.editor = defaults(element.dataset.kind); view.choices = []; view.login = null; }
      if (action === 'models-edit') { view.editor = { ...view.data.connections.find(item => item.id === element.dataset.id), apiKey: '' }; view.choices = []; view.login = null; await fetchChoices(element.dataset.id); }
      if (action === 'models-discover') { view.busy = true; await fetchChoices(element.dataset.id, view.editor.kind === 'api'); }
      if (['models-import-codex', 'models-import-grok'].includes(action)) {
        const kind = action === 'models-import-codex' ? 'codex' : 'grok';
        view.busy = true; view.data = await provided.api('/api/model-settings/local/import', 'POST', { kind });
        syncRoutingDraft(view.data);
        view.editor = { ...view.data.connections.find(item => item.id === view.data.importedId), apiKey: '' }; view.summary = view.data;
        await fetchChoices(view.editor.id); provided.toast(`已导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'}`);
      }
      if (action === 'models-activate' || action === 'models-deactivate') {
        const id = action === 'models-deactivate' ? null : element.dataset.id;
        view.busy = true;
        view.data = await provided.api('/api/model-settings/active', 'POST', { id });
        syncRoutingDraft(view.data);
        view.summary = view.data;
        view.quotaId = null;
        provided.toast(id === null ? '已取消默认' : '已设为默认');
        await provided.refresh?.();
      }
      if (action === 'models-remove') {
        view.busy = true;
        view.data = await provided.api(`/api/model-settings/connections/${encodeURIComponent(element.dataset.id)}`, 'DELETE', {});
        syncRoutingDraft(view.data);
        view.editor = selectedEditor(view.data);
        view.summary = view.data;
      }
      if (action === 'models-login') await beginLogin(element.dataset.id);
      if (action === 'models-cancel-login') { clearTimeout(loginTimer); view.login = await provided.api(`/api/model-settings/connections/${encodeURIComponent(element.dataset.id)}/login`, 'DELETE', {}); }
    } catch (error) { view.error = error.message; provided.toast(error.message, true); }
    finally { view.busy = false; provided.render(); }
  }

  document.addEventListener('click', event => { if (view.quotaId && !event.target.closest('.quota-popover,.quota-signal')) closeQuota(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && view.quotaId) closeQuota(); });
  document.addEventListener('submit', event => {
    if (event.target.id === 'model-connection-form') { event.preventDefault(); void submit(event.target); }
    if (event.target.id === 'model-routing-form') { event.preventDefault(); void submitRouting(); }
  });
  document.addEventListener('input', event => {
    if (!event.target.closest('#model-connection-form') || !view.editor || !event.target.name || event.target.name === 'preset') return;
    view.editor[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  });
  document.addEventListener('change', event => {
    if (event.target.closest('#model-routing-form') && view.routingDraft) {
      if (event.target.dataset.roleKey) {
        const roleKey = event.target.dataset.roleKey;
        const field = event.target.dataset.roleField;
        const slot = view.routingDraft.roles[roleKey];
        if (!slot) return;
        slot[field] = event.target.value;
        if (field === 'connection_id') {
          const models = modelsForConnection(view.data, slot.connection_id);
          const conn = (view.data?.connections || []).find(c => c.id === slot.connection_id);
          slot.model = models[0]?.id || conn?.model || '';
          const levels = thinkingForRole(view.data, slot.connection_id, slot.model, '');
          if (slot.thinking_level && !levels.includes(slot.thinking_level)) {
            slot.thinking_level = roleKey === 'fast_read' && levels.includes('off') ? 'off' : (levels.includes('high') ? 'high' : (levels[0] || ''));
          }
          bindings?.render?.();
        } else if (field === 'model') {
          const levels = thinkingForRole(view.data, slot.connection_id, slot.model, '');
          if (slot.thinking_level && !levels.includes(slot.thinking_level)) {
            slot.thinking_level = roleKey === 'fast_read' && levels.includes('off') ? 'off' : (levels.includes('high') ? 'high' : (levels[0] || ''));
          }
          bindings?.render?.();
        }
        return;
      }
      if (event.target.dataset.engId) {
        const engId = event.target.dataset.engId;
        const tierKey = event.target.dataset.engTier;
        const field = event.target.dataset.engField;
        const tier = view.routingDraft.engines?.[engId]?.[tierKey];
        if (!tier) return;
        tier[field] = event.target.value;
        if (field === 'model') {
          if (!tier.model) {
            tier.effort = '';
          } else {
            const eng = (view.data?.enabledEngines || []).find(e => e.id === engId);
            const matched = (eng?.models || []).find(m => m.id === tier.model);
            if (Array.isArray(matched?.efforts)) {
              if (!matched.efforts.length) tier.effort = '';
              else if (!matched.efforts.includes(tier.effort)) {
                tier.effort = matched.efforts.includes('high') ? 'high' : matched.efforts[0];
              }
            }
          }
          bindings?.render?.();
        }
        return;
      }
    }
    if (!event.target.closest('#model-connection-form') || !view.editor) return;
    if (event.target.name === 'preset') {
      const preset = view.data.presets.find(item => item.id === event.target.value);
      if (!preset) return;
      Object.assign(view.editor, { provider: preset.id, baseUrl: preset.baseUrl, api: preset.api });
      view.choices = [];
      bindings.render();
    }
    if (event.target.name === 'model' || event.target.name === 'provider') {
      if (event.target.name === 'provider') view.choices = [];
      const choices = modelChoices(view.data, view.editor);
      const selected = view.data.connections.find(item => item.id === view.editor.id && item.provider === view.editor.provider);
      document.querySelector('#models-choices')?.replaceChildren(...choices.map(item => new Option(item.name || item.id, item.id)));
      document.querySelector('#models-thinking-levels')?.replaceChildren(...editorThinkingChoices(choices, view.editor, selected)
        .map(level => new Option(level === 'off' ? '关闭' : level, level)));
    }
  });

  return {
    sidebar,
    start,
    load,
    render,
    act,
    thinkingChoices,
    sync: summary => {
      if (!summary) return;
      if (summary.work?.engineId !== view.summary?.work?.engineId || summary.activeId !== view.summary?.activeId) {
        view.loadedAt = 0;
      }
      view.summary = summary;
      invalidateSidebar?.();
    },
    current: () => view.summary,
    bind: provided => { bindings = provided; },
  };
})();
