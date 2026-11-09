'use strict';
globalThis.SummonModels = (() => {
  const view = { data: null, summary: null, editor: null, choices: [], error: '', busy: false, login: null, loadedAt: 0, quotaId: null, connectingId: null };
  let bindings, loginTimer, usageTimer, loading, invalidateSidebar;
  const kinds = { codex: 'Codex 订阅', grok: 'Grok 订阅', api: '通用 API' };
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
    if (usage?.status === 'not_connected') return `<small class="model-usage-note">${esc(usage.note || '待手动接入，尚未读取额度')}</small>`;
    if (usage?.status === 'unconfigured') return '<small class="model-usage-note">选择聊天模型后读取额度</small>';
    if (usage?.status === 'connecting') return '<small class="model-usage-note">正在接入引擎…</small>';
    if (!usage || usage.status === 'loading') return '<small class="model-usage-note">正在读取额度…</small>';
    if (usage.status === 'shared') return `<small class="model-usage-note">${esc(usage.note)}</small>`;
    const windows = percents(usage), money = balances(usage);
    const shown = compact ? windows.slice(0, 2) : windows;
    const credits = typeof usage?.credits === 'number' && Number.isFinite(usage.credits) ? usage.credits : null;
    const status = usage.status === 'error' ? (usage.stale ? '上次读取 · 暂未更新' : '暂时无法读取') : usage.unsupported ? '未提供额度接口' : !windows.length && !money.length && credits === null && !usage.unlimited ? '供应商未返回额度数值' : '';
    return `${money.length ? `<div class="model-balances">${money.map(value => `<strong>${esc(formatMoney(value))}<small>余额</small></strong>`).join('')}</div>` : ''}
      ${shown.map(item => `<div class="model-quota-window"><div><span>${esc(item.name)}</span><strong>${Math.round(item.remainingPercent)}% <small>剩余</small></strong></div><span class="model-quota-track ${item.remainingPercent < 10 ? 'low' : ''}" role="meter" aria-label="${esc(item.name)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(item.remainingPercent)}"><i style="width:${Math.max(0, Math.min(100, item.remainingPercent))}%"></i></span>${!compact && item.resetsAt ? `<small>${esc(resetTime(item.resetsAt))} · ${esc(new Date(item.resetsAt).toLocaleString('zh-CN'))}</small>` : ''}</div>`).join('')}
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
    const awaiting = executor ? !item.enabled : !item.configured;
    const usage = awaiting ? null : item.usage, windows = percents(usage), money = balances(usage);
    const loading = item.connecting || !awaiting && (!usage || usage.status === 'loading');
    const codexWindows = windows.filter(window => window.limitId === 'codex');
    const primaryWindows = codexWindows.length ? codexWindows : windows;
    const isApi = item.kind === 'api', weekly = primaryWindows.find(window => duration(window) === 10080);
    const fiveHours = primaryWindows.find(window => duration(window) === 300);
    const main = weekly || primaryWindows[0] || null;
    const short = fiveHours && main !== fiveHours ? fiveHours : null;
    const balance = money.find(value => value.currency === 'CNY') || money[0] || null;
    const ring = awaiting || loading ? null : isApi ? 100 : main?.remainingPercent ?? null;
    const dots = !loading && !isApi && short ? Math.ceil(Math.max(0, Math.min(100, short.remainingPercent)) / 25) : null;
    const percentage = main ? `${Math.round(Math.max(0, Math.min(100, main.remainingPercent)))}%` : '';
    let value = '';
    if (loading) value = item.connecting ? '配置中' : '读取中';
    else if (awaiting) value = item.label || (executor ? '待接入' : '待配置');
    else if (isApi) value = balance ? formatMoney(balance) : '暂无余额';
    else if (dots === null) value = percentage || (executor ? '已接入' : '暂无额度');
    const role = executor ? '工作引擎' : '聊天引擎 · Pi';
    const details = [role, item.name, item.model, awaiting ? item.note || '待手动接入，尚未读取额度' : isApi ? '圆环常满 · 底部显示余额' : main ? `圆环：${main.name}，剩余 ${Math.round(main.remainingPercent)}%` : '暂未取得订阅额度'];
    if (loading) details.push(item.connecting ? '正在配置引擎' : '正在读取额度');
    else if (awaiting) details.push('点击查看接入设置');
    else if (isApi) {
      details.push(...money.map(value => `余额 ${formatMoney(value)}`));
      if (!balance) details.push('余额尚未返回');
    } else {
      if (short) details.push(`四点：5 小时额度剩余 ${Math.round(short.remainingPercent)}%`);
      else details.push(percentage ? `未返回独立的 5 小时额度，底部显示${main.name}剩余 ${percentage}` : '暂未取得额度');
      for (const window of windows) details.push(`${window.name}：剩余 ${Math.round(window.remainingPercent)}%${window.resetsAt ? `，${resetTime(window.resetsAt)}` : ''}`);
    }
    if (usage?.status === 'error') details.push(usage.stale ? '当前为上次额度，最新数据暂不可用' : usage.error || '暂时无法读取额度');
    if (!awaiting) details.push('点击查看额度');
    const description = [...new Set(details.filter(Boolean))].join('\n');
    const low = isApi ? balance?.amount <= 0 : ring !== null && ring < 10 || short?.remainingPercent < 10;
    const points = [[21, 49], [28.5, 51.5], [35.5, 51.5], [43, 49]];
    const brand = loading ? '<i class="quota-signal-spinner" aria-hidden="true"></i>' : awaiting ? '' : globalThis.SummonModelIcons.svg(item);
    return `<button class="quota-signal ${executor ? 'executor' : ''} ${ring === null ? 'is-unknown' : ''} ${low ? 'is-low' : ''} ${usage?.status === 'error' ? 'is-stale' : ''}" data-action="models-quota" data-id="${esc(item.id || item.role)}" aria-label="${esc(description)}" aria-busy="${Boolean(loading)}" aria-expanded="${view.quotaId === (item.id || item.role)}" aria-controls="model-quota-popover">
      <span class="quota-signal-visual"><svg class="quota-signal-face" viewBox="0 0 64 59" aria-hidden="true" focusable="false"><path class="quota-signal-track" d="M15.74 45.26 A23 23 0 1 1 48.26 45.26" pathLength="100"/><path class="quota-signal-progress" d="M15.74 45.26 A23 23 0 1 1 48.26 45.26" pathLength="100" stroke-dasharray="${ring === null ? 0 : Math.max(0, Math.min(100, ring))} 100"/>
        ${dots === null ? '' : points.map(([x, y], index) => `<circle class="quota-signal-dot ${index < dots ? 'on' : ''}" cx="${x}" cy="${y}" r="1.9"/>`).join('')}</svg><span class="quota-signal-brand">${brand}</span>${value ? `<span class="quota-signal-value ${balance && !loading ? 'is-money' : ''}" aria-hidden="true">${esc(value)}</span>` : ''}</span>
      <span class="quota-signal-role">${executor ? 'WORK' : 'CHAT'}</span></button>`;
  }
  function executorButton(item, esc) {
    if (!item || item.role !== 'executor' || item.id === 'pi') return '';
    const action = item.enabled ? 'disconnect' : 'connect';
    return `<button class="${item.enabled ? 'secondary-button' : 'primary-button'}" data-action="models-executor-${action}" data-id="${esc(item.id)}" ${view.busy || item.connecting ? 'disabled' : ''}>${esc(item.enabled ? '断开' : item.id === 'codex-cli' ? '同意并接入 Codex' : '接入')}</button>`;
  }
  function sidebar({ esc, icon, invalidate, chatConfigured, chatConnecting, setup }) {
    invalidateSidebar = invalidate;
    const current = view.summary;
    const chat = { ...(current?.chat || { role: 'chat', name: '聊天引擎' }), configured: chatConfigured, connecting: chatConnecting };
    if (!chatConfigured) chat.usage = { status: 'unconfigured' };
    const pendingId = view.connectingId || setup?.engineId;
    const work = { ...(current?.executors?.find(item => item.id === pendingId) || current?.workExecutor || current?.executors?.[0]
      || { role: 'executor', id: 'codex-cli', kind: 'codex-cli', name: 'Codex', enabled: false, label: '待接入', usage: { status: 'not_connected' } }) };
    if (work.id === pendingId && (view.connectingId || ['queued', 'running'].includes(setup?.status))) work.connecting = true;
    if (work.id === setup?.engineId && setup?.status === 'waiting' && !work.enabled) work.label = '待授权';
    const rows = [chat, work];
    const selected = rows.find(item => (item.id || item.role) === view.quotaId);
    const popover = selected ? `<aside class="quota-popover" id="model-quota-popover" role="dialog" aria-label="${esc(selected.name || '模型')}接入与额度"><header><span class="quota-popover-icon">${globalThis.SummonModelIcons.svg(selected, 28)}</span><div><small>${selected.role === 'executor' ? 'WORK · 执行引擎' : 'CHAT · 聊天引擎'}</small><strong>${esc(selected.name || '正在读取')}</strong></div><button class="icon-button" data-action="models-quota-close" aria-label="关闭额度详情">${icon('close', 16)}</button></header>${selected.model ? `<p class="quota-popover-model">${esc(selected.model)}</p>` : ''}<div class="quota-popover-usage">${usageBody(selected.usage, esc)}</div>${executorButton(selected, esc)}<footer><button data-action="navigate" data-view="models">管理模型与引擎 ${icon('arrow', 14)}</button></footer></aside>` : '';
    return `<section class="sidebar-models" aria-label="模型与引擎额度">${rows.map(item => signal(item, esc)).join('')}${popover}</section>`;
  }
  function closeQuota() {
    view.quotaId = null; document.querySelector('.quota-popover')?.remove();
    for (const button of document.querySelectorAll('[data-action="models-quota"]')) button.setAttribute('aria-expanded', 'false');
    invalidateSidebar?.();
  }
  const defaults = kind => ({ kind, name: kinds[kind], model: kind === 'codex' ? 'gpt-6-luna' : kind === 'grok' ? 'grok-4.7' : '',
    provider: kind === 'api' ? 'openai-compatible' : kind === 'grok' ? 'xai' : 'openai-codex', api: kind === 'api' ? 'openai-completions' : 'openai-responses',
    baseUrl: '', thinkingLevel: 'high', apiKey: '' });
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
      if (!view.editor) view.editor = { ...data.connections.find(item => item.id === data.activeId), apiKey: '' };
    }).catch(error => { view.error = error.message; }).finally(() => { loading = null; });
    return loading;
  }
  function render({ esc, icon }) {
    if (!view.data) return `<div class="page models-page"><h1>模型与引擎</h1><p class="subtle">${esc(view.error || '正在读取配置…')}</p><button class="secondary-button" data-action="models-reload">重新读取</button></div>`;
    const data = view.data, editor = view.editor, active = data.connections.find(item => item.id === data.activeId), summary = view.summary || data;
    const executor = summary.workExecutor;
    const engineRows = (summary.executors || []).map(item => `<div class="models-executor-row"><div><strong>${esc(item.name)}</strong><p>${esc(item.id === executor?.id ? '当前工作引擎' : item.note || item.label)}</p></div><div class="models-executor-actions">${item.enabled && item.id !== executor?.id ? `<button class="secondary-button" data-action="models-executor-select" data-id="${esc(item.id)}" ${view.busy ? 'disabled' : ''}>用于工作</button>` : ''}${executorButton(item, esc)}</div></div>`).join('');
    const input = (label, name, value, options = {}) => `<label class="models-field"><span>${label}</span><input name="${name}" ${options.type ? `type="${options.type}"` : ''} value="${esc(value ?? '')}" ${options.required ? 'required' : ''} ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''} ${options.list ? `list="${options.list}"` : ''} ${options.type === 'password' ? 'autocomplete="new-password"' : ''} ${options.type === 'number' ? 'min="128" step="1"' : ''}></label>`;
    const select = (label, name, values, current) => `<label class="models-field"><span>${label}</span><select name="${name}">${values.map(([value, title]) => `<option value="${esc(value)}" ${current === value ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;
    const selected = editor?.id ? data.connections.find(item => item.id === editor.id) : null;
    const login = view.login?.id === editor?.id ? view.login : null;
    const waiting = login && ['starting', 'waiting'].includes(login.status);
    const localLogin = ['codex-local', 'grok-local'].includes(editor?.authMode), localBrand = editor?.kind === 'codex' ? 'Codex' : 'Grok';
    const authorization = editor && editor.kind !== 'api' ? `<div class="models-auth-panel"><div><strong>${selected?.configured ? '订阅已连接' : '连接你的订阅'}</strong><p>${localLogin ? `使用这台机器的 ${localBrand} 登录。Pi 负责聊天和工具调用。` : '授权完成后，Pi 可以直接使用此账号的聊天模型。'}</p></div>${!selected ? `<button type="button" class="secondary-button" data-action="models-import-${esc(editor.kind)}">导入本机 ${localBrand} 登录</button>` : ''}${selected && !localLogin ? `<button type="button" class="secondary-button" data-action="models-login" data-id="${esc(editor.id)}" ${waiting || view.busy ? 'disabled' : ''}>${selected.configured ? '重新授权' : '授权订阅'}</button>` : ''}
      ${waiting ? `<div class="models-device-code"><span>${login.status === 'starting' ? '正在获取授权码…' : '在授权页面输入此代码'}</span>${login.userCode ? `<strong>${esc(login.userCode)}</strong>` : ''}${login.verificationUri ? `<a class="primary-button" href="${esc(login.verificationUri)}" target="_blank" rel="noopener noreferrer">打开授权页面 ${icon('link', 14)}</a>` : ''}<button type="button" class="text-button" data-action="models-cancel-login" data-id="${esc(editor.id)}">取消授权</button></div>` : ''}${login?.error ? `<p class="models-inline-error">${esc(login.error)}</p>` : ''}</div>` : '';
    const form = editor ? `<section class="models-editor"><div class="models-section-heading"><div><p class="models-eyebrow">${esc(kinds[editor.kind])}</p><h2>${editor.id ? esc(editor.name) : '添加聊天模型'}</h2></div>${selected?.active ? '<span class="model-active-badge">当前聊天模型</span>' : ''}</div>
      <form id="model-connection-form"><input type="hidden" name="kind" value="${esc(editor.kind)}">${input('连接名称', 'name', editor.name, { required: true })}
      ${editor.kind === 'api' ? `${select('服务商', 'provider', data.presets.map(item => [item.id, item.name]), editor.provider)}${select('接口协议', 'api', [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']], editor.api)}${input('API 地址', 'baseUrl', editor.baseUrl, { required: true, type: 'url', placeholder: 'https://api.example.com/v1' })}${input('API Key', 'apiKey', editor.apiKey, { type: 'password', placeholder: selected?.configured ? '已保存；留空保持当前 Key' : '输入 API Key' })}<label class="models-checkbox"><input name="allowNoKey" type="checkbox" ${editor.allowNoKey ? 'checked' : ''}>这个服务无需 API Key</label>` : authorization}
      <div class="models-field-heading"><span>聊天模型</span>${selected ? `<button type="button" class="text-button" data-action="models-discover" data-id="${esc(selected.id)}">${editor.kind === 'api' ? '获取模型目录' : '查看可选模型'}</button>` : ''}</div>
      <input class="models-model-input" name="model" list="models-choices" value="${esc(editor.model)}" placeholder="填写或选择模型 ID" required><datalist id="models-choices">${view.choices.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')}</datalist>
      <p class="models-field-hint">可以直接填写模型 ID；可用范围由当前账号决定。</p>
      ${select('思考强度', 'thinkingLevel', [['off', '关闭思考'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '最高']], editor.thinkingLevel)}
      <details class="models-advanced"><summary>上下文与余额查询</summary><div class="models-form-grid">${input('上下文上限 · Token', 'contextWindow', editor.contextWindow, { type: 'number', placeholder: '留空使用模型默认' })}${input('输出上限 · Token', 'maxTokens', editor.maxTokens, { type: 'number', placeholder: '留空使用模型默认' })}</div>${editor.kind === 'api' ? `<p class="models-field-hint">DeepSeek 与 OpenRouter 自动读取余额。其他服务可填写自己的余额接口。</p>${input('余额查询路径', 'balancePath', editor.balancePath, { placeholder: '/account/balance' })}<div class="models-form-grid">${input('余额 JSON 字段', 'balanceField', editor.balanceField, { placeholder: 'data.balance' })}${input('币种', 'balanceCurrency', editor.balanceCurrency || 'USD', { placeholder: 'USD' })}</div>` : ''}</details>
      <div class="models-form-actions"><button class="primary-button" type="submit" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在保存…' : editor.kind === 'api' ? '保存并用于聊天' : selected?.configured ? '保存配置' : '保存并授权'}</button>${selected?.configured && !selected.active ? `<button class="secondary-button" type="button" data-action="models-activate" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>用于 Pi 聊天</button>` : ''}${selected && !selected.active ? `<button class="text-button models-remove" type="button" data-action="models-remove" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>移除此连接</button>` : ''}</div></form></section>` : '';
    return `<div class="page models-page"><header class="models-header"><div><button class="text-button" data-action="navigate" data-view="chat">${icon('back', 16)}返回聊天</button><p class="models-eyebrow">SETTINGS / MODELS</p><h1>模型与引擎</h1><p>选择聊天的模型，查看干活的额度。</p></div><button class="secondary-button" data-action="models-refresh-usage" ${view.busy ? 'disabled' : ''}>${icon('refresh', 15)}刷新额度</button></header>
      ${view.error ? `<p class="models-inline-error" role="alert">${esc(view.error)}</p>` : ''}
      <div class="models-engine-overview"><section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot"></span><h2>聊天引擎</h2><span>Pi</span></div><strong>${esc(active?.name || '尚未选择')}</strong><p>${esc(active?.model || '')}</p>${usageBody(summary.chat?.usage, esc)}</section><section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot executor"></span><h2>工作引擎</h2><span>${esc(executor?.name || '待选择')}</span></div>${engineRows}${executor?.usage ? usageBody(executor.usage, esc) : ''}${executor?.id !== 'pi' ? `<button class="text-button" data-action="models-executor-select" data-id="pi" ${view.busy ? 'disabled' : ''}>使用内置 Pi</button>` : ''}</section></div>
      <div class="models-configuration"><section class="models-connections"><div class="models-section-heading"><h2>聊天模型连接</h2><span>${data.connections.length}</span></div><div class="models-add-types">${Object.entries(kinds).map(([kind, label]) => `<button data-action="models-new" data-kind="${kind}" ${view.busy ? 'disabled' : ''}>${icon('plus', 14)}${label}</button>`).join('')}</div><div class="models-connection-list">${data.connections.map(item => `<button class="models-connection ${editor?.id === item.id ? 'selected' : ''}" data-action="models-edit" data-id="${esc(item.id)}"><span class="models-provider-monogram ${item.kind}">${globalThis.SummonModelIcons.svg(item, 22)}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.model)}</small><small>${esc(kinds[item.kind])}${item.identity ? ` · ${esc(item.identity)}` : ''}</small></span>${item.active ? '<i class="models-selected-dot" title="当前聊天模型"></i>' : !item.configured ? '<small class="models-unconfigured">待连接</small>' : ''}</button>`).join('')}</div><p class="models-list-note">聊天模型由所有 Bot 共用。额度按账号显示，同一订阅不会因接入多个引擎而增加。</p></section>${form}</div></div>`;
  }
  async function updateUsage(force) {
    if (!bindings) return;
    try { view.summary = await bindings.api('/api/model-settings/usage', 'POST', { force }); await bindings.refresh?.(); bindings.render(); }
    catch (error) { if (force) bindings.toast(error.message, true); }
  }
  async function fetchChoices(id, discover = false) {
    const value = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/models${discover ? '?discover=1' : ''}`);
    view.choices = value.models || [];
  }
  async function pollLogin(id) {
    clearTimeout(loginTimer);
    try {
      view.login = await bindings.api(`/api/model-settings/connections/${encodeURIComponent(id)}/login`);
      if (['starting', 'waiting'].includes(view.login.status)) loginTimer = setTimeout(() => { void pollLogin(id); }, 2000);
      if (view.login.status === 'completed') {
        view.data = await bindings.api('/api/model-settings'); view.summary = view.data;
        if (view.editor?.id === id) view.editor = { ...view.data.connections.find(item => item.id === id), apiKey: '' };
        bindings.toast('订阅已连接，可以选择用于 Pi 聊天');
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
    const previousIds = new Set(view.data.connections.map(item => item.id));
    view.busy = true; view.error = ''; bindings.render();
    try {
      view.data = await bindings.api('/api/model-settings/connections', 'POST', payload);
      const entry = view.data.connections.find(item => payload.id ? item.id === payload.id : !previousIds.has(item.id));
      view.editor = { ...entry, apiKey: '' }; view.summary = view.data;
      if (entry.kind === 'api') { view.data = await bindings.api('/api/model-settings/active', 'POST', { id: entry.id }); view.summary = view.data; bindings.toast('聊天模型已更新'); }
      else if (!entry.configured) await beginLogin(entry.id);
      else bindings.toast('模型配置已保存');
      await bindings.refresh?.();
    } catch (error) { view.error = error.message; bindings.toast(error.message, true); }
    finally { view.busy = false; bindings.render(); }
  }
  async function act(action, element, provided) {
    bindings = provided;
    if (action === 'models-quota') { view.quotaId = view.quotaId === element.dataset.id ? null : element.dataset.id; return provided.render(); }
    if (action === 'models-quota-close') return closeQuota();
    if (action === 'models-refresh-usage') return updateUsage(true);
    if (action === 'models-reload') { view.loadedAt = 0; await load(provided.api, provided.render, provided.toast, provided.refresh); return provided.render(); }
    if (view.busy) return;
    try {
      view.error = '';
      if (!view.data) await load(provided.api, provided.render, provided.toast, provided.refresh);
      if (['models-executor-connect', 'models-executor-disconnect'].includes(action)) {
        const enabled = action === 'models-executor-connect';
        view.busy = true; view.connectingId = enabled ? element.dataset.id : null; provided.render();
        view.data = await provided.api('/api/model-settings/executors/' + encodeURIComponent(element.dataset.id), 'POST', { enabled, select: enabled });
        view.summary = view.data; view.loadedAt = Date.now();
        const connected = view.data.executors.some(item => item.id === element.dataset.id && item.enabled);
        provided.toast(enabled ? connected ? '工作引擎已接入' : '正在配置工作引擎' : '工作引擎已断开');
        await provided.refresh?.();
      }
      if (action === 'models-executor-select') {
        view.busy = true; provided.render();
        view.data = await provided.api('/api/model-settings/executors/active', 'POST', { id: element.dataset.id });
        view.summary = view.data; view.loadedAt = Date.now();
        await provided.refresh?.();
      }
      if (action === 'models-new') { view.editor = defaults(element.dataset.kind); view.choices = []; view.login = null; }
      if (action === 'models-edit') { view.editor = { ...view.data.connections.find(item => item.id === element.dataset.id), apiKey: '' }; view.choices = []; view.login = null; await fetchChoices(element.dataset.id); }
      if (action === 'models-discover') { view.busy = true; await fetchChoices(element.dataset.id, view.editor.kind === 'api'); }
      if (['models-import-codex', 'models-import-grok'].includes(action)) {
        const kind = action === 'models-import-codex' ? 'codex' : 'grok';
        view.busy = true; view.data = await provided.api('/api/model-settings/local/import', 'POST', { kind });
        view.editor = { ...view.data.connections.find(item => item.id === view.data.importedId), apiKey: '' }; view.summary = view.data;
        await fetchChoices(view.editor.id); provided.toast(`已导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 登录，选择模型后即可用于聊天`);
      }
      if (action === 'models-activate') { view.busy = true; view.data = await provided.api('/api/model-settings/active', 'POST', { id: element.dataset.id }); view.summary = view.data; provided.toast('Pi 聊天模型已切换'); await provided.refresh?.(); }
      if (action === 'models-remove') { view.busy = true; view.data = await provided.api(`/api/model-settings/connections/${encodeURIComponent(element.dataset.id)}`, 'DELETE', {}); view.editor = { ...view.data.connections.find(item => item.id === view.data.activeId), apiKey: '' }; view.summary = view.data; }
      if (action === 'models-login') await beginLogin(element.dataset.id);
      if (action === 'models-cancel-login') { clearTimeout(loginTimer); view.login = await provided.api(`/api/model-settings/connections/${encodeURIComponent(element.dataset.id)}/login`, 'DELETE', {}); }
    } catch (error) { view.error = error.message; provided.toast(error.message, true); }
    finally { view.busy = false; view.connectingId = null; provided.render(); }
  }
  document.addEventListener('click', event => { if (view.quotaId && !event.target.closest('.quota-popover,.quota-signal')) closeQuota(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && view.quotaId) closeQuota(); });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'model-connection-form') return;
    event.preventDefault(); void submit(event.target);
  });
  document.addEventListener('input', event => {
    if (!event.target.closest('#model-connection-form') || !view.editor || !event.target.name) return;
    view.editor[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  });
  document.addEventListener('change', event => {
    if (!event.target.closest('#model-connection-form') || !view.editor) return;
    if (event.target.name === 'provider') {
      const preset = view.data.presets.find(item => item.id === event.target.value);
      Object.assign(view.editor, { provider: event.target.value, baseUrl: preset?.baseUrl || '', api: preset?.api || 'openai-completions' });
      bindings.render();
    }
  });
  return { sidebar, start, load, render, act, sync: summary => { if (summary) view.summary = summary; }, current: () => view.summary };
})();
