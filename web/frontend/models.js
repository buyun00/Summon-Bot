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
    { key: 'fast_read', title: '① 快读路由', hint: '高频判断谁该醒来与发言，建议最快低成本 + 关闭思考' },
    { key: 'conversation', title: '② 群聊主脑', hint: '日常聊天、审活与派单调度，建议主力模型 + 高推理' },
    { key: 'pi_session', title: '③ 内置 Pi 会话', hint: '纯文本长资料阅读与无外部工作引擎时的兜底' },
  ];
  const tierMeta = [
    { key: 'standard', title: '常规默认档', required: true, hint: '现场摸底、排障、脚本与常规修改（缺省自动用此档）' },
    { key: 'deep', title: '深度攻关档', required: false, hint: '复杂多文件开发、深度架构设计与疑难根因攻关' },
    { key: 'fast', title: '轻量快查档', required: false, hint: '极速轻量采样、小脚本或简单文件整理' },
  ];
  const commonThinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const effortOptions = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
  const thinkingChoices = (levels, current) => [...new Set(['off', ...(levels ?? commonThinkingLevels), current].filter(Boolean))];
  const formatMoney = balance => {
    if (!balance || !Number.isFinite(balance.amount)) return '';
    try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency || 'USD', maximumFractionDigits: 2 }).format(balance.amount); }
    catch { return `${balance.amount.toFixed(2)} ${balance.currency || ''}`; }
  };
  const formatTokens = n => {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(v);
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

  function statsBlock(stats, esc) {
    if (!stats || typeof stats !== 'object') return '';
    if (stats.calls !== undefined) {
      if (!stats.calls) return '<small class="model-usage-note">今日暂无聊天模型调用</small>';
      const hit = stats.cacheHitRate !== null && stats.cacheHitRate !== undefined ? ` · 缓存命中 ${stats.cacheHitRate}%` : '';
      return `<small class="model-usage-note">今日 ${stats.calls} 次调用 · 输入 ${esc(formatTokens(stats.inputTokens))}${esc(hit)}</small>`;
    }
    if (stats.todayRuns !== undefined) {
      const avg = stats.avgSeconds != null ? ` · 均耗时 ${stats.avgSeconds}s` : '';
      const live = stats.running > 0 ? ` · 运行中 ${stats.running}` : '';
      if (!stats.todayRuns && !stats.running) return '<small class="model-usage-note">今日暂无工作会话</small>';
      return `<small class="model-usage-note">今日 ${stats.todayRuns} 次会话（成功 ${stats.completed} / 失败 ${stats.failed}${esc(avg)}${esc(live)}）</small>`;
    }
    return '';
  }

  function usageBody(usage, esc, compact = false, extra = {}) {
    if (usage?.status === 'not_connected') return `<small class="model-usage-note">${esc(usage.note || '尚未启用或接入')}</small>`;
    if (usage?.status === 'unconfigured') return '<small class="model-usage-note">选择模型后读取额度</small>';
    if (usage?.status === 'connecting') return '<small class="model-usage-note">正在接入引擎…</small>';
    if (usage?.status === 'cli_managed') {
      const tiers = extra.tiers || {};
      const tierLine = [
        tiers.standard?.model ? `常规：${tiers.standard.model}` : '',
        tiers.deep?.model ? `深度：${tiers.deep.model}` : '',
      ].filter(Boolean).join(' · ');
      return `${tierLine ? `<p class="model-usage-note">${esc(tierLine)}</p>` : ''}
        ${statsBlock(usage.stats || extra.stats, esc)}
        ${!compact && usage.note ? `<small class="model-usage-note">${esc(usage.note)}</small>` : ''}`;
    }
    if (!usage || usage.status === 'loading') return '<small class="model-usage-note">正在读取额度…</small>';
    if (usage.status === 'shared') return `<small class="model-usage-note">${esc(usage.note)}</small>`;
    const windows = percents(usage), money = balances(usage);
    const shown = compact ? windows.slice(0, 2) : windows;
    const credits = typeof usage?.credits === 'number' && Number.isFinite(usage.credits) ? usage.credits : null;
    const status = usage.status === 'error' ? (usage.stale ? '上次读取 · 暂未更新' : '暂时无法读取') : usage.unsupported ? '未提供额度接口' : !windows.length && !money.length && credits === null && !usage.unlimited ? '供应商未返回额度数值' : '';
    return `${money.length ? `<div class="model-balances">${money.map(value => `<strong>${esc(formatMoney(value))}<small>余额</small></strong>`).join('')}</div>` : ''}
      ${shown.map(item => `<div class="model-quota-window"><div><span>${esc(item.name)}</span><strong>${Math.round(item.remainingPercent)}% <small>剩余</small></strong></div><span class="model-quota-track ${item.remainingPercent < 10 ? 'low' : ''}" role="meter" aria-label="${esc(item.name)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(item.remainingPercent)}"><i style="width:${Math.max(0, Math.min(100, item.remainingPercent))}%"></i></span>${!compact && item.resetsAt ? `<small>${esc(resetTime(item.resetsAt))} · ${esc(new Date(item.resetsAt).toLocaleString('zh-CN'))}</small>` : ''}</div>`).join('')}
      ${statsBlock(extra.todayStats || extra.stats, esc)}
      ${credits !== null && !compact ? `<span class="model-usage-note">附加点数 ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(credits)} credits</span>` : ''}
      ${usage?.unlimited ? '<span class="model-usage-note">额外额度不设限</span>' : ''}
      ${status ? `<small class="model-usage-note ${usage?.status === 'error' ? 'quota-warning' : ''}">${esc(status)}</small>` : ''}
      ${!compact && usage?.error ? `<p class="models-inline-error">${esc(usage.error)}</p>` : ''}
      ${!compact && usage?.note ? `<p class="model-usage-note">${esc(usage.note)}</p>` : ''}
      ${!compact && usage?.checkedAt ? `<small class="model-usage-note">更新于 ${esc(new Date(usage.checkedAt).toLocaleString('zh-CN'))}</small>` : ''}`;
  }

  const duration = window => Number.isFinite(window.durationMinutes) ? window.durationMinutes
    : /每周|周额|week/i.test(window.name || '') ? 10080 : /(?:5\s*小时|5\s*hour)/i.test(window.name || '') ? 300 : null;

  function signal(item, esc) {
    const executor = item.role === 'executor';
    const awaiting = executor ? (item.enabled === false || item.configured === false) : item.configured === false;
    const usage = awaiting ? null : item.usage;
    const cliManaged = !awaiting && usage?.status === 'cli_managed';
    const windows = percents(usage), money = balances(usage);
    const loading = item.connecting || (!awaiting && !cliManaged && (!usage || usage.status === 'loading'));
    const codexWindows = windows.filter(window => window.limitId === 'codex');
    const primaryWindows = codexWindows.length ? codexWindows : windows;
    const isApi = item.kind === 'api', weekly = primaryWindows.find(window => duration(window) === 10080);
    const fiveHours = primaryWindows.find(window => duration(window) === 300);
    const main = weekly || primaryWindows[0] || null;
    const short = fiveHours && main !== fiveHours ? fiveHours : null;
    const balance = money.find(value => value.currency === 'CNY') || money[0] || null;
    const ring = awaiting || loading ? null : (isApi || cliManaged) ? 100 : main?.remainingPercent ?? null;
    const dots = !loading && !isApi && !cliManaged && short ? Math.ceil(Math.max(0, Math.min(100, short.remainingPercent)) / 25) : null;
    const percentage = main ? `${Math.round(Math.max(0, Math.min(100, main.remainingPercent)))}%` : '';
    let value = '';
    if (loading) value = item.connecting ? '配置中' : '读取中';
    else if (awaiting) value = item.label || (executor ? '未启用' : '待配置');
    else if (cliManaged) {
      const st = usage?.stats || item.stats;
      value = st?.running > 0 ? `运行 ${st.running}` : st?.todayRuns > 0 ? `今日 ${st.todayRuns} 次` : '已就绪';
    } else if (isApi) value = balance ? formatMoney(balance) : '暂无余额';
    else if (dots === null) value = percentage || (usage?.unsupported ? '已连接' : '暂无额度');

    const roleShort = executor ? (item.roleLabel || '工作引擎') : '聊天模型';
    const role = executor ? `工作引擎 · ${roleShort}` : '聊天模型';
    const details = [role, item.name, item.model, awaiting ? item.note || '尚未启用或配置' : cliManaged ? (usage.note || '本机 CLI 已就绪') : isApi ? '圆环常满 · 底部显示余额' : main ? `圆环：${main.name}，剩余 ${Math.round(main.remainingPercent)}%` : '暂未取得订阅额度'];
    if (!awaiting && !loading && !cliManaged) {
      if (isApi) details.push(...money.map(v => `余额 ${formatMoney(v)}`));
      else {
        if (short) details.push(`四点：5 小时额度剩余 ${Math.round(short.remainingPercent)}%`);
        for (const w of windows) details.push(`${w.name}：剩余 ${Math.round(w.remainingPercent)}%${w.resetsAt ? `，${resetTime(w.resetsAt)}` : ''}`);
      }
    }
    if (!awaiting) details.push('点击查看详情');
    const description = [...new Set(details.filter(Boolean))].join('\n');
    const low = isApi ? balance?.amount <= 0 : (!cliManaged && (ring !== null && ring < 10 || short?.remainingPercent < 10));
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
    const popoverEyebrow = selected?.role === 'executor' ? '当前工作引擎' : '当前聊天模型';
    const popoverMeta = [selected?.model, selected?.identity].filter(Boolean).join(' · ');
    const otherEngines = selected?.role === 'executor' && Array.isArray(selected.enabledEngines) && selected.enabledEngines.length > 1
      ? `<p class="model-usage-note">全部已启用引擎：${esc(selected.enabledEngines.map(e => `${e.shortLabel}(${e.model || '默认'})`).join(' / '))}</p>`
      : '';
    const popover = selected ? `<aside class="quota-popover" id="model-quota-popover" role="dialog" aria-label="${esc(selected.name || '模型')}状态与额度"><header><span class="quota-popover-icon">${globalThis.SummonModelIcons.svg(selected, 28)}</span><div><small>${esc(popoverEyebrow)}</small><strong>${esc(selected.name || '正在读取')}</strong></div><button class="icon-button" data-action="models-quota-close" aria-label="关闭详情">${icon('close', 16)}</button></header>${popoverMeta ? `<p class="quota-popover-model">${esc(popoverMeta)}</p>` : ''}<div class="quota-popover-usage">${usageBody(selected.usage, esc, false, selected)}${otherEngines}</div><footer><button data-action="open-settings" data-tab="models">管理模型与角色分配 ${icon('arrow', 14)}</button></footer></aside>` : '';
    return `<section class="sidebar-models" aria-label="模型与工作引擎状态">${rows.map(item => signal(item, esc)).join('')}${popover}</section>`;
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

  function syncRoutingDraft(data) {
    const configured = (data?.connections || []).filter(c => c.configured !== false);
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
      for (const { key, hint } of tierMeta) {
        const t = savedTiers[key];
        engines[eng.id][key] = {
          model: t?.model || '',
          effort: t?.effort || '',
          when: t?.when || (key === 'standard' ? hint : ''),
        };
      }
    }
    view.routingDraft = {
      roles,
      engines,
      autoGrantPurposeConnections: data?.autoGrantPurposeConnections !== false,
    };
  }

  function modelsForConnection(data, connId) {
    const conn = (data?.connections || []).find(c => c.id === connId);
    if (!conn) return [];
    const cached = view.connModelsCache[connId] || [];
    const base = conn.kind === 'codex'
      ? (data.codexModels || [])
      : (data.presets?.find(p => p.id === conn.provider)?.models || []);
    const merged = [...base, ...cached];
    if (conn.model && !merged.some(m => m.id === conn.model)) {
      merged.unshift({ id: conn.model, name: conn.model });
    }
    return [...new Map(merged.map(m => [m.id, m])).values()];
  }

  function modelChoices(data, editor) {
    if (editor?.kind === 'codex') {
      return [...new Map([...(data.codexModels || []), ...view.choices].map(item => [item.id, item])).values()];
    }
    const preset = data.presets.find(item => item.id === editor?.provider);
    return [...new Map([...(preset?.models || []), ...view.choices].map(item => [item.id, item])).values()];
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
    if (!view.data) return `<div class="${embedded ? 'models-embedded' : 'page models-page'}">${embedded ? '' : '<h1>模型与角色分配</h1>'}<p class="subtle">${esc(view.error || '正在读取配置…')}</p><button class="secondary-button small-button" data-action="models-reload">重新读取</button></div>`;
    const data = view.data, editor = view.editor, active = data.connections.find(item => item.id === data.activeId), summary = view.summary || data;
    if (!view.routingDraft) syncRoutingDraft(data);
    const configuredConns = (data.connections || []).filter(c => c.configured !== false);
    const enabledEngines = data.enabledEngines || [];

    const input = (label, name, value, options = {}) => `<label class="models-field"><span>${label}</span><input name="${name}" ${options.type ? `type="${options.type}"` : ''} value="${esc(value ?? '')}" ${options.required ? 'required' : ''} ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''} ${options.list ? `list="${options.list}"` : ''} ${options.type === 'password' ? 'autocomplete="new-password"' : ''} ${options.type === 'number' ? 'min="128" step="1"' : ''}></label>`;
    const select = (label, name, values, current) => `<label class="models-field"><span>${label}</span><select name="${name}">${values.map(([value, title]) => `<option value="${esc(value)}" ${current === value ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;

    const selected = editor?.id ? data.connections.find(item => item.id === editor.id) : null;
    const defaultAction = selected ? `<button class="secondary-button" type="button"
      data-action="${selected.active ? 'models-deactivate' : 'models-activate'}" data-id="${esc(selected.id)}"
      ${view.busy ? 'disabled' : ''}>${selected.active ? '取消默认' : '设为主聊天连接'}</button>` : '';
    const choices = modelChoices(data, editor);
    const thinkingHints = editorThinkingChoices(choices, editor, selected);
    const login = view.login?.id === editor?.id ? view.login : null;
    const waiting = login && ['starting', 'waiting'].includes(login.status);
    const localLogin = ['codex-local', 'grok-local'].includes(editor?.authMode), localBrand = editor?.kind === 'codex' ? 'Codex' : 'Grok';
    const authorization = editor && editor.kind !== 'api' ? `<div class="models-auth-panel"><div><strong>${selected?.configured ? '订阅已连接' : '连接你的订阅'}</strong><p>${localLogin ? `使用这台机器的 ${localBrand} 登录。` : '授权完成后，聊天角色可以直接选用此账号的模型。'}</p></div>${!selected ? `<button type="button" class="secondary-button" data-action="models-import-${esc(editor.kind)}">导入本机 ${localBrand} 登录</button>` : ''}${selected && !localLogin ? `<button type="button" class="secondary-button" data-action="models-login" data-id="${esc(editor.id)}" ${waiting || view.busy ? 'disabled' : ''}>${selected.configured ? '重新授权' : '授权订阅'}</button>` : ''}
      ${waiting ? `<div class="models-device-code"><span>${login.status === 'starting' ? '正在获取授权码…' : '在授权页面输入此代码'}</span>${login.userCode ? `<strong>${esc(login.userCode)}</strong>` : ''}${login.verificationUri ? `<a class="primary-button" href="${esc(login.verificationUri)}" target="_blank" rel="noopener noreferrer">打开授权页面 ${icon('link', 14)}</a>` : ''}<button type="button" class="text-button" data-action="models-cancel-login" data-id="${esc(editor.id)}">取消授权</button></div>` : ''}${login?.error ? `<p class="models-inline-error">${esc(login.error)}</p>` : ''}</div>` : '';

    // Overview cards (real chat + real enabled work engine)
    const activeRolePills = data.roleRouting ? `<div class="models-effective-summary">${roleMeta.map(({ key, title }) => {
      const slot = data.roleRouting[key];
      const cName = slot ? (data.connections.find(c => c.id === slot.connection_id)?.name || '') : '';
      const label = slot ? `${cName ? `${cName} / ` : ''}${slot.model} · ${slot.thinking_level || '默认'}` : '未分配';
      return `<span class="models-effective-pill">${esc(title)}：${esc(label)}</span>`;
    }).join('')}</div>` : '';
    const work = summary.work;
    const workTiersPills = work?.tiers ? `<div class="models-effective-summary">${tierMeta.filter(t => work.tiers[t.key]?.model).map(t => `<span class="models-effective-pill">${esc(t.title)}：${esc(work.tiers[t.key].model)}${work.tiers[t.key].effort ? ` · ${esc(work.tiers[t.key].effort)}` : ''}</span>`).join('')}</div>` : '';
    const workCard = work ? `<section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot executor"></span><h2>当前工作引擎</h2><span>${esc(work.roleLabel || '工作引擎')}</span></div><strong>${esc(work.name || '未启用')}</strong><p>${esc(work.model || (work.configured === false ? '未启用工作引擎' : ''))}</p>${workTiersPills}${work.configured === false ? `<small class="model-usage-note">${esc(work.note || '可在「工作引擎」页开启')}</small>` : usageBody(work.usage, esc, false, work)}</section>` : '';

    // Role-based routing card (chat roles + enabled work engines + AI auto-recommend button)
    const autoCfg = data.autoConfig || {};
    const autoSourceLabel = autoCfg.source === 'ai' ? 'AI 智能分析' : autoCfg.source === 'heuristic' ? '智能默认' : autoCfg.source === 'manual' ? '已手动微调' : '';
    const autoBanner = autoCfg.rationale ? `<div class="models-auto-banner"><div><strong>${esc(autoSourceLabel || '自动配置建议')}</strong>${autoCfg.updatedAt ? `<small>${esc(new Date(autoCfg.updatedAt).toLocaleString('zh-CN'))}</small>` : ''}</div><p>${esc(autoCfg.rationale)}</p></div>` : '';

    const chatRoleRows = configuredConns.length ? roleMeta.map(({ key, title, hint }) => {
      const draft = view.routingDraft.roles[key] || { connection_id: '', model: '', thinking_level: '' };
      const connModels = modelsForConnection(data, draft.connection_id);
      const listId = `role-models-${key}`;
      return `<div class="models-role-row">
        <div class="models-role-meta"><strong>${esc(title)}</strong><small>${esc(hint)}</small></div>
        <div class="models-role-controls">
          <select data-role-key="${key}" data-role-field="connection_id" aria-label="${esc(title)}连接">${configuredConns.map(c => `<option value="${esc(c.id)}" ${draft.connection_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <input data-role-key="${key}" data-role-field="model" list="${listId}" value="${esc(draft.model)}" placeholder="选择或输入模型 ID" required>
          <input data-role-key="${key}" data-role-field="thinking_level" list="models-thinking-all" value="${esc(draft.thinking_level)}" placeholder="思考深度">
        </div>
        <datalist id="${listId}">${connModels.map(m => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}</datalist>
      </div>`;
    }).join('') : '<p class="models-field-hint">尚未接入可用的聊天连接，请先在下方添加并配置一个连接；接入后会自动触发 AI 首轮分配。</p>';

    const engineBlocks = enabledEngines.length ? enabledEngines.map(eng => {
      const engDraft = view.routingDraft.engines[eng.id] || {};
      const listId = `eng-models-${eng.id}`;
      const isRefreshing = view.refreshingEngineId === eng.id;
      const sourceText = eng.modelSource === 'cli' ? `CLI 实测 ${eng.models.length} 个模型` : `已加载 ${eng.models.length} 个候选模型`;
      return `<div class="models-engine-role-block">
        <div class="models-engine-role-head">
          <span class="models-provider-monogram">${globalThis.SummonModelIcons.svg({ role: 'executor', id: eng.id, kind: eng.id }, 20)}</span>
          <div><strong>${esc(eng.name)}</strong><small>${esc(sourceText)}</small></div>
          <button type="button" class="text-button" data-action="models-refresh-engine-models" data-id="${esc(eng.id)}" ${isRefreshing || view.busy ? 'disabled' : ''}>${icon('refresh', 13)} ${isRefreshing ? '拉取中…' : '刷新模型列表'}</button>
        </div>
        ${tierMeta.map(({ key, title, required, hint }) => {
          const td = engDraft[key] || { model: '', effort: '', when: '' };
          return `<div class="models-tier-row">
            <div class="models-role-meta"><strong>${esc(title)}${required ? ' *' : ''}</strong><small>${esc(hint)}</small></div>
            <div class="models-tier-controls">
              <input data-eng-id="${esc(eng.id)}" data-eng-tier="${key}" data-eng-field="model" list="${listId}" value="${esc(td.model)}" placeholder="${required ? '必填：选择默认模型' : '留空不启用此档'}" ${required ? 'required' : ''}>
              <select data-eng-id="${esc(eng.id)}" data-eng-tier="${key}" data-eng-field="effort" aria-label="${esc(title)}思考深度">${effortOptions.map(lv => `<option value="${esc(lv)}" ${td.effort === lv ? 'selected' : ''}>${lv ? `思考：${lv}` : '思考：默认'}</option>`).join('')}</select>
            </div>
          </div>`;
        }).join('')}
        <datalist id="${listId}">${(eng.models || []).map(m => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}</datalist>
      </div>`;
    }).join('') : '<p class="models-field-hint">当前未启用本机工作引擎。可在「工作引擎」设置页开启 AGY / Codex / Claude Code 等，开启后这里会自动显示对应档位并由 AI 自动分配。</p>';

    const routingSection = `<section class="models-purpose-card">
      <div class="models-section-heading">
        <div><p class="models-eyebrow">ROLE ROUTING</p><h2>按角色分配模型（聊天 + 工作引擎）</h2></div>
        <button type="button" class="primary-button" data-action="models-auto-recommend" ${view.busy || view.autoRecommending || (!configuredConns.length && !enabledEngines.length) ? 'disabled' : ''}>${view.autoRecommending ? 'AI 正在分析最新模型…' : '✨ AI 分析并自动填写'}</button>
      </div>
      <p class="models-purpose-subtitle">只展示当前已接入的聊天连接与已启用的工作引擎。新模型发布或新增接入后，点右上角按钮即可让 AI 扫描最新可用目录并自动完成分档；也可在下方手动微调。</p>
      ${autoBanner}
      <form id="model-routing-form">
        <h3 class="models-subhead">聊天模型角色（仅显示已接入的聊天连接）</h3>
        <div class="models-role-list">${chatRoleRows}</div>
        <h3 class="models-subhead">工作引擎档位（仅显示已启用的工作引擎）</h3>
        <div class="models-engine-role-list">${engineBlocks}</div>
        <datalist id="models-thinking-all">${['off', ...commonThinkingLevels].map(level => `<option value="${esc(level)}">${level === 'off' ? '关闭思考 (off)' : esc(level)}</option>`).join('')}</datalist>
        <label class="models-checkbox"><input name="autoGrantPurposeConnections" type="checkbox" ${view.routingDraft.autoGrantPurposeConnections !== false ? 'checked' : ''}>跟随默认配置的 Bot 自动获得上述角色所选连接的使用权</label>
        <div class="models-form-actions"><button class="secondary-button" type="submit" ${view.busy || view.autoRecommending ? 'disabled' : ''}>${view.busy ? '正在保存…' : '保存手动微调'}</button></div>
      </form>
    </section>`;

    const form = editor ? `<section class="models-editor"><div class="models-section-heading"><div><p class="models-eyebrow">${esc(kinds[editor.kind])}</p><h2>${editor.id ? esc(editor.name) : '添加聊天连接'}</h2></div>${selected?.active ? '<span class="model-active-badge">主聊天连接</span>' : ''}</div>
      <form id="model-connection-form"><input type="hidden" name="kind" value="${esc(editor.kind)}">${input('连接名称', 'name', editor.name)}
      ${editor.kind === 'api' ? `${input('服务商 ID', 'provider', editor.provider)}${select('应用服务商预设', 'preset', [['', '选择预设'], ...data.presets.map(item => [item.id, item.name])], '')}${select('接口协议', 'api', [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']], editor.api)}${input('API 地址', 'baseUrl', editor.baseUrl, { required: true, type: 'url', placeholder: 'https://api.example.com/v1' })}${input('API Key', 'apiKey', editor.apiKey, { type: 'password', placeholder: selected?.configured ? '已保存；留空保持当前 Key' : '输入 API Key' })}<label class="models-checkbox"><input name="allowNoKey" type="checkbox" ${editor.allowNoKey ? 'checked' : ''}>这个服务无需 API Key</label>` : authorization}
      <div class="models-field-heading"><span>默认模型</span>${selected ? `<button type="button" class="text-button" data-action="models-discover" data-id="${esc(selected.id)}">${editor.kind === 'api' ? '获取最新模型目录' : '查看可选模型'}</button>` : ''}</div>
      <input class="models-model-input" name="model" list="models-choices" value="${esc(editor.model)}" placeholder="填写或选择模型 ID" ${editor.kind === 'api' ? 'required' : ''}><datalist id="models-choices">${choices.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')}</datalist>
      <p class="models-field-hint">接入后可在上方「按角色分配」区由 AI 自动匹配到快读 / 群聊主脑 / 内置 Pi。</p>
      ${input('默认思考强度', 'thinkingLevel', editor.thinkingLevel, { placeholder: '留空由角色路由决定', list: 'models-thinking-levels' })}
      <datalist id="models-thinking-levels">${thinkingHints.map(level => `<option value="${esc(level)}">${level === 'off' ? '关闭思考' : esc(level)}</option>`).join('')}</datalist>
      <details class="models-advanced"><summary>上下文与余额查询</summary><div class="models-form-grid">${input('上下文上限 · Token', 'contextWindow', editor.contextWindow, { type: 'number', placeholder: '留空使用模型默认' })}${input('输出上限 · Token', 'maxTokens', editor.maxTokens, { type: 'number', placeholder: '留空使用模型默认' })}</div>${editor.kind === 'api' ? `<p class="models-field-hint">DeepSeek 与 OpenRouter 自动读取余额。其他服务可填写自己的余额接口。</p>${input('余额查询路径', 'balancePath', editor.balancePath, { placeholder: '/account/balance' })}<div class="models-form-grid">${input('余额 JSON 字段', 'balanceField', editor.balanceField, { placeholder: 'data.balance' })}${input('币种', 'balanceCurrency', editor.balanceCurrency || 'USD', { placeholder: 'USD' })}</div>` : ''}</details>
      <div class="models-form-actions"><button class="primary-button" type="submit" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在保存…' : editor.kind === 'api' || selected?.configured ? '保存连接' : '保存并授权'}</button>${defaultAction}${selected && !selected.active ? `<button class="text-button models-remove" type="button" data-action="models-remove" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>移除此连接</button>` : ''}</div></form></section>` : '';

    return `<div class="${embedded ? 'models-embedded' : 'page models-page'}">${embedded ? `<div class="settings-inline-toolbar"><p class="subtle">按角色分配聊天模型与工作引擎，支持 AI 一键扫描最新模型自动填写</p><button type="button" class="secondary-button small-button" data-action="models-refresh-usage" ${view.busy || view.refreshingUsage ? 'disabled' : ''}>${icon('refresh', 14)}${view.refreshingUsage ? '刷新中…' : '刷新状态'}</button></div>` : `${globalThis.SummonPageNav?.('models') || ''}<header class="models-header"><div><p class="models-eyebrow">SETTINGS / MODELS</p><h1>模型与角色分配</h1><p>按角色管理聊天与工作引擎模型，接入或发布新模型后可一键由 AI 自动分析填写。</p></div><button class="secondary-button" data-action="models-refresh-usage" ${view.busy || view.refreshingUsage ? 'disabled' : ''}>${icon('refresh', 15)}${view.refreshingUsage ? '正在刷新…' : '刷新状态'}</button></header>`}
      ${view.error ? `<p class="models-inline-error" role="alert">${esc(view.error)}</p>` : ''}
      <div class="models-engine-overview"><section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot"></span><h2>当前聊天模型</h2><span>Pi</span></div><strong>${esc(active?.name || '尚未接入')}</strong><p>${esc(summary.chat?.model || active?.model || '')}</p>${activeRolePills}${active?.configured === false ? '<small class="model-usage-note">待连接</small>' : usageBody(summary.chat?.usage, esc, false, summary.chat || {})}</section>${workCard}</div>
      ${routingSection}
      <div class="models-configuration"><section class="models-connections"><div class="models-section-heading"><h2>已接入聊天连接</h2><span>${data.connections.length}</span></div><div class="models-add-types">${Object.entries(kinds).map(([kind, label]) => `<button data-action="models-new" data-kind="${kind}" ${view.busy ? 'disabled' : ''}>${icon('plus', 14)}${label}</button>`).join('')}</div><div class="models-connection-list">${data.connections.map(item => `<button class="models-connection ${editor?.id === item.id ? 'selected' : ''}" data-action="models-edit" data-id="${esc(item.id)}"><span class="models-provider-monogram ${item.kind}">${globalThis.SummonModelIcons.svg(item, 22)}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.model)}</small><small>${esc(kinds[item.kind])}${item.identity ? ` · ${esc(item.identity)}` : ''}</small></span>${item.configured === false ? '<small class="models-unconfigured">待连接</small>' : ''}${item.active ? '<i class="models-selected-dot" role="img" aria-label="当前主聊天连接" title="当前主聊天连接"></i>' : ''}</button>`).join('')}</div><p class="models-list-note">只在这里管理 API Key / 订阅凭据；具体哪个角色用哪个模型在上方统一分配。</p></section>${form}</div></div>`;
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
    payload.thinkingLevel = payload.thinkingLevel.trim() || null;
    const previousIds = new Set(view.data.connections.map(item => item.id));
    view.busy = true; view.error = ''; bindings.render();
    try {
      view.data = await bindings.api('/api/model-settings/connections', 'POST', payload);
      syncRoutingDraft(view.data);
      const entry = view.data.connections.find(item => payload.id ? item.id === payload.id : !previousIds.has(item.id));
      view.editor = { ...entry, apiKey: '' }; view.summary = view.data;
      if (entry.kind !== 'api' && !entry.configured) await beginLogin(entry.id);
      else bindings.toast('连接配置已保存');
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
        for (const { key, hint } of tierMeta) {
          const t = tiers[key];
          if (t?.model?.trim()) {
            packed[key] = {
              model: t.model.trim(),
              effort: t.effort?.trim() || null,
              when: t.when?.trim() || hint,
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
      bindings.toast('角色与引擎模型分配已保存');
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
      const src = result.autoRecommendation?.source === 'ai' ? 'AI 已分析最新目录并自动填写生效' : '已按最新可用目录智能填写生效';
      bindings.toast(src);
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
      if (target && Array.isArray(res?.models)) {
        target.models = res.models;
        target.modelSource = res.source || target.modelSource;
      }
      bindings.toast(`已拉取 ${res?.models?.length || 0} 个可用模型`);
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
        await fetchChoices(view.editor.id); provided.toast(`已导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 登录`);
      }
      if (action === 'models-activate' || action === 'models-deactivate') {
        const id = action === 'models-deactivate' ? null : element.dataset.id;
        view.busy = true;
        view.data = await provided.api('/api/model-settings/active', 'POST', { id });
        syncRoutingDraft(view.data);
        view.summary = view.data;
        view.quotaId = null;
        provided.toast(id === null ? '已取消主聊天连接' : '已设为主聊天连接');
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
    if (event.target.closest('#model-routing-form') && view.routingDraft) {
      if (event.target.dataset.roleKey) {
        const slot = view.routingDraft.roles[event.target.dataset.roleKey];
        if (slot) slot[event.target.dataset.roleField] = event.target.value;
        return;
      }
      if (event.target.dataset.engId) {
        const tier = view.routingDraft.engines?.[event.target.dataset.engId]?.[event.target.dataset.engTier];
        if (tier) tier[event.target.dataset.engField] = event.target.value;
        return;
      }
      if (event.target.name === 'autoGrantPurposeConnections') {
        view.routingDraft.autoGrantPurposeConnections = event.target.checked;
        return;
      }
    }
    if (!event.target.closest('#model-connection-form') || !view.editor || !event.target.name || event.target.name === 'preset') return;
    view.editor[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  });
  document.addEventListener('change', event => {
    if (event.target.closest('#model-routing-form') && view.routingDraft) {
      if (event.target.dataset.roleKey && event.target.dataset.roleField === 'connection_id') {
        const roleKey = event.target.dataset.roleKey;
        const connId = event.target.value;
        const conn = (view.data?.connections || []).find(c => c.id === connId);
        if (conn && view.routingDraft.roles[roleKey]) {
          view.routingDraft.roles[roleKey].connection_id = connId;
          view.routingDraft.roles[roleKey].model = conn.model;
          if (!view.connModelsCache[connId]) void fetchChoices(connId, false).then(() => bindings?.render?.()).catch(() => {});
          bindings?.render?.();
        }
        return;
      }
      if (event.target.dataset.engId && event.target.dataset.engField === 'effort') {
        const tier = view.routingDraft.engines?.[event.target.dataset.engId]?.[event.target.dataset.engTier];
        if (tier) tier.effort = event.target.value;
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
        .map(level => new Option(level === 'off' ? '关闭思考' : level, level)));
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
