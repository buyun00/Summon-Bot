'use strict';
globalThis.SummonModels = (() => {
  const view = { data: null, summary: null, editor: null, choices: [], error: '', busy: false, refreshingUsage: false, login: null, loadedAt: 0, quotaId: null, codexDraft: null };
  let bindings, loginTimer, usageTimer, loading, invalidateSidebar;
  const kinds = { codex: 'Codex 订阅', grok: 'Grok 订阅', api: '通用 API' };
  const purposeCategories = [['deepseek', 'DeepSeek API'], ['openai', 'OpenAI API'], ['codex', 'Codex 订阅']];
  const purposeLabels = [['fast_read', '① 快读'], ['conversation', '② 群主对话'], ['pi_session', '③ 独立 Pi']];
  const commonThinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const thinkingChoices = (levels, current) => [...new Set(['off', ...(levels ?? commonThinkingLevels), current].filter(Boolean))];
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
    if (usage?.status === 'unconfigured') return '<small class="model-usage-note">选择模型后读取额度</small>';
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
    const awaiting = executor ? (item.enabled === false || item.configured === false) : item.configured === false;
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
    else if (dots === null) value = percentage || (usage?.unsupported ? '已连接' : '暂无额度');
    const roleShort = executor ? (item.roleLabel || '工作引擎') : '默认模型';
    const role = executor ? roleShort : '默认模型 · Pi';
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
    const popoverEyebrow = selected?.role === 'executor' ? (selected.roleLabel || '工作引擎') : '默认模型';
    const popoverMeta = [selected?.model, selected?.identity].filter(Boolean).join(' · ');
    const popover = selected ? `<aside class="quota-popover" id="model-quota-popover" role="dialog" aria-label="${esc(selected.name || '模型')}接入与额度"><header><span class="quota-popover-icon">${globalThis.SummonModelIcons.svg(selected, 28)}</span><div><small>${esc(popoverEyebrow)}</small><strong>${esc(selected.name || '正在读取')}</strong></div><button class="icon-button" data-action="models-quota-close" aria-label="关闭额度详情">${icon('close', 16)}</button></header>${popoverMeta ? `<p class="quota-popover-model">${esc(popoverMeta)}</p>` : ''}<div class="quota-popover-usage">${usageBody(selected.usage, esc)}</div><footer><button data-action="open-settings" data-tab="models">管理模型连接 ${icon('arrow', 14)}</button></footer></aside>` : '';
    return `<section class="sidebar-models" aria-label="模型与工作引擎额度">${rows.map(item => signal(item, esc)).join('')}${popover}</section>`;
  }
  function closeQuota() {
    view.quotaId = null; document.querySelector('.quota-popover')?.remove();
    for (const button of document.querySelectorAll('[data-action="models-quota"]')) button.setAttribute('aria-expanded', 'false');
    invalidateSidebar?.();
  }
  const defaults = kind => ({ kind, name: kinds[kind], model: kind === 'codex' ? 'gpt-6.1-terra' : kind === 'grok' ? 'grok-4.7' : '',
    provider: kind === 'api' ? 'openai-compatible' : kind === 'grok' ? 'xai' : 'openai-codex', api: kind === 'api' ? 'openai-completions' : 'openai-responses',
    baseUrl: '', thinkingLevel: null, apiKey: '' });
  function selectedEditor(data) {
    const entry = data.connections.find(item => item.id === data.activeId) ?? data.connections[0];
    return entry ? { ...entry, apiKey: '' } : null;
  }
  function syncCodexDraft(data) {
    const list = data?.externalEngines?.codex?.recommended || [];
    view.codexDraft = list.map(item => ({ model: item.model || '', efforts: Array.isArray(item.efforts) ? item.efforts.join(', ') : String(item.efforts || '') }));
  }
  function modelChoices(data, editor) {
    if (editor?.kind === 'codex') {
      return [...new Map([...(data.codexModels || []), ...view.choices].map(item => [item.id, item])).values()];
    }
    const preset = data.presets.find(item => item.id === editor?.provider);
    return [...new Map([...(preset?.models || []), ...view.choices].map(item => [item.id, item])).values()];
  }
  function categoryChoices(data, category) {
    if (category === 'codex') return data.codexModels || [];
    return data.presets.find(item => item.id === category)?.models || [];
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
      syncCodexDraft(data);
      if (!view.editor) view.editor = selectedEditor(data);
    }).catch(error => { view.error = error.message; }).finally(() => { loading = null; });
    return loading;
  }
  function render({ esc, icon, embedded = false }) {
    if (!view.data) return `<div class="${embedded ? 'models-embedded' : 'page models-page'}">${embedded ? '' : '<h1>模型连接</h1>'}<p class="subtle">${esc(view.error || '正在读取配置…')}</p><button class="secondary-button small-button" data-action="models-reload">重新读取</button></div>`;
    const data = view.data, editor = view.editor, active = data.connections.find(item => item.id === data.activeId), summary = view.summary || data;
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
    const authorization = editor && editor.kind !== 'api' ? `<div class="models-auth-panel"><div><strong>${selected?.configured ? '订阅已连接' : '连接你的订阅'}</strong><p>${localLogin ? `使用这台机器的 ${localBrand} 登录。` : '授权完成后，Pi 可以直接使用此账号的模型。'}</p></div>${!selected ? `<button type="button" class="secondary-button" data-action="models-import-${esc(editor.kind)}">导入本机 ${localBrand} 登录</button>` : ''}${selected && !localLogin ? `<button type="button" class="secondary-button" data-action="models-login" data-id="${esc(editor.id)}" ${waiting || view.busy ? 'disabled' : ''}>${selected.configured ? '重新授权' : '授权订阅'}</button>` : ''}
      ${waiting ? `<div class="models-device-code"><span>${login.status === 'starting' ? '正在获取授权码…' : '在授权页面输入此代码'}</span>${login.userCode ? `<strong>${esc(login.userCode)}</strong>` : ''}${login.verificationUri ? `<a class="primary-button" href="${esc(login.verificationUri)}" target="_blank" rel="noopener noreferrer">打开授权页面 ${icon('link', 14)}</a>` : ''}<button type="button" class="text-button" data-action="models-cancel-login" data-id="${esc(editor.id)}">取消授权</button></div>` : ''}${login?.error ? `<p class="models-inline-error">${esc(login.error)}</p>` : ''}</div>` : '';
    const connOverride = selected ? (data.connectionPurposes?.[selected.id] || {}) : {};
    const effectivePills = selected?.effectivePurposes ? `<div class="models-effective-summary">${purposeLabels.map(([key, title]) => {
      const item = selected.effectivePurposes[key];
      const connName = item && item.connection_id !== selected.id ? (data.connections.find(c => c.id === item.connection_id)?.name || item.connection_id) + ' / ' : '';
      return `<span class="models-effective-pill">${esc(title)}：${item ? esc(`${connName}${item.id} · ${item.thinking_level ?? '默认'}`) : '未配置'}</span>`;
    }).join('')}</div>` : '';
    const overridePanel = selected ? `<details class="models-advanced"><summary>单连接用途覆写（留空沿用类别默认表）</summary>${effectivePills}<div id="model-connection-override" data-conn-id="${esc(selected.id)}">${purposeLabels.map(([key, title]) => {
      const cell = connOverride[key] || {};
      return `<div class="models-override-row"><span>${esc(title)}</span><select data-ov-purpose="${key}" data-ov-field="connection_id"><option value="">沿用本连接</option>${data.connections.map(c => `<option value="${esc(c.id)}" ${cell.connection_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><input data-ov-purpose="${key}" data-ov-field="model" list="models-choices" value="${esc(cell.model || '')}" placeholder="留空跟表"><input data-ov-purpose="${key}" data-ov-field="thinking_level" list="models-thinking-all" value="${esc(cell.thinking_level ?? '')}" placeholder="留空跟表"></div>`;
    }).join('')}<div class="models-form-actions"><button type="button" class="secondary-button" data-action="models-save-override" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>保存单连接覆写</button>${Object.keys(connOverride).length ? `<button type="button" class="text-button" data-action="models-clear-override" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>清除覆写</button>` : ''}</div></div></details>` : '';
    const form = editor ? `<section class="models-editor"><div class="models-section-heading"><div><p class="models-eyebrow">${esc(kinds[editor.kind])}</p><h2>${editor.id ? esc(editor.name) : '添加模型'}</h2></div>${selected?.active ? '<span class="model-active-badge">当前模型</span>' : ''}</div>
      <form id="model-connection-form"><input type="hidden" name="kind" value="${esc(editor.kind)}">${input('连接名称', 'name', editor.name)}
      ${editor.kind === 'api' ? `${input('服务商 ID', 'provider', editor.provider)}${select('应用服务商预设', 'preset', [['', '选择预设'], ...data.presets.map(item => [item.id, item.name])], '')}${select('接口协议', 'api', [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']], editor.api)}${input('API 地址', 'baseUrl', editor.baseUrl, { required: true, type: 'url', placeholder: 'https://api.example.com/v1' })}${input('API Key', 'apiKey', editor.apiKey, { type: 'password', placeholder: selected?.configured ? '已保存；留空保持当前 Key' : '输入 API Key' })}<label class="models-checkbox"><input name="allowNoKey" type="checkbox" ${editor.allowNoKey ? 'checked' : ''}>这个服务无需 API Key</label>` : authorization}
      <div class="models-field-heading"><span>模型</span>${selected ? `<button type="button" class="text-button" data-action="models-discover" data-id="${esc(selected.id)}">${editor.kind === 'api' ? '获取模型目录' : '查看可选模型'}</button>` : ''}</div>
      <input class="models-model-input" name="model" list="models-choices" value="${esc(editor.model)}" placeholder="填写或选择模型 ID" ${editor.kind === 'api' ? 'required' : ''}><datalist id="models-choices">${choices.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')}</datalist>
      <p class="models-field-hint">可以直接填写模型 ID；可用范围由当前账号决定。</p>
      ${input('思考强度', 'thinkingLevel', editor.thinkingLevel, { placeholder: '留空使用供应商默认', list: 'models-thinking-levels' })}
      <datalist id="models-thinking-levels">${thinkingHints.map(level => `<option value="${esc(level)}">${level === 'off' ? '关闭思考' : esc(level)}</option>`).join('')}</datalist>
      ${overridePanel}
      <details class="models-advanced"><summary>上下文与余额查询</summary><div class="models-form-grid">${input('上下文上限 · Token', 'contextWindow', editor.contextWindow, { type: 'number', placeholder: '留空使用模型默认' })}${input('输出上限 · Token', 'maxTokens', editor.maxTokens, { type: 'number', placeholder: '留空使用模型默认' })}</div>${editor.kind === 'api' ? `<p class="models-field-hint">DeepSeek 与 OpenRouter 自动读取余额。其他服务可填写自己的余额接口。</p>${input('余额查询路径', 'balancePath', editor.balancePath, { placeholder: '/account/balance' })}<div class="models-form-grid">${input('余额 JSON 字段', 'balanceField', editor.balanceField, { placeholder: 'data.balance' })}${input('币种', 'balanceCurrency', editor.balanceCurrency || 'USD', { placeholder: 'USD' })}</div>` : ''}</details>
      <div class="models-form-actions"><button class="primary-button" type="submit" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在保存…' : editor.kind === 'api' || selected?.configured ? '保存配置' : '保存并授权'}</button>${defaultAction}${selected && !selected.active ? `<button class="text-button models-remove" type="button" data-action="models-remove" data-id="${esc(selected.id)}" ${view.busy ? 'disabled' : ''}>移除此连接</button>` : ''}</div></form></section>` : '';
    const purposeDefaults = data.purposeDefaults || {};
    const codexRows = view.codexDraft || [];
    const purposeSection = `<section class="models-purpose-card"><div class="models-section-heading"><div><p class="models-eyebrow">PURPOSE TABLE</p><h2>用途模型与思考深度默认表</h2></div></div><p class="models-purpose-subtitle">按连接类别配置 ① 快读、② 群主对话与 ③ 独立 Pi 的默认模型与思考档。跟随默认表的 Bot 在下一轮对话或新开 Pi 会话时自动生效；保存时会按目标模型校验思考档。</p>
      <form id="model-purposes-form"><div class="models-purpose-scroll"><table class="models-purpose-table"><thead><tr><th>连接类别</th>${purposeLabels.map(([, title]) => `<th>${esc(title)}（模型 / 思考档）</th>`).join('')}</tr></thead><tbody>
      ${purposeCategories.map(([category, title]) => `<tr><th>${esc(title)}</th>${purposeLabels.map(([purpose]) => {
        const cell = purposeDefaults[category]?.[purpose] || {};
        return `<td><div class="models-purpose-cell"><input name="pd:${category}:${purpose}:model" list="models-choices-${category}" value="${esc(cell.model || '')}" placeholder="模型 ID" required><input name="pd:${category}:${purpose}:thinking" list="models-thinking-all" value="${esc(cell.thinking_level ?? '')}" placeholder="默认"></div></td>`;
      }).join('')}</tr>`).join('')}
      </tbody></table></div>
      ${purposeCategories.map(([category]) => `<datalist id="models-choices-${category}">${categoryChoices(data, category).map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')}</datalist>`).join('')}
      <datalist id="models-thinking-all">${['off', ...commonThinkingLevels].map(level => `<option value="${esc(level)}">${level === 'off' ? '关闭思考 (off)' : esc(level)}</option>`).join('')}</datalist>
      <label class="models-checkbox"><input name="autoGrantPurposeConnections" type="checkbox" ${data.autoGrantPurposeConnections !== false ? 'checked' : ''}>跟随默认表的 Bot 自动获得用途表指定连接的使用权（避免切表报权限不足）</label>
      <div class="models-form-actions"><button class="primary-button" type="submit" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在保存…' : '保存用途模型表'}</button></div></form></section>`;
    const codexSection = `<section class="models-purpose-card"><div class="models-section-heading"><div><p class="models-eyebrow">WORK ENGINES</p><h2>③ Codex 工作引擎推荐模型组合（软推荐）</h2></div><button type="button" class="secondary-button" data-action="models-codex-add-row" ${view.busy ? 'disabled' : ''}>${icon('plus', 14)}添加组合</button></div><p class="models-purpose-subtitle">保存在 <code>model-connections.json</code> 中，通过缓存断点后的 <code>work_engines</code> 运行时事实动态提供给各群 Bot 按任务难度自主选择；修改后即时生效且不破坏对话前缀缓存。</p>
      <form id="model-codex-rec-form"><div class="models-codex-list">${codexRows.map((row, idx) => `<div class="models-codex-row"><input data-codex-idx="${idx}" data-codex-field="model" list="models-choices-codex" value="${esc(row.model)}" placeholder="例如 gpt-6.2-sol" required><input data-codex-idx="${idx}" data-codex-field="efforts" value="${esc(row.efforts)}" placeholder="思考档（逗号分隔，如 xhigh, max）" required><button type="button" class="text-button models-remove" data-action="models-codex-remove-row" data-idx="${idx}" ${codexRows.length <= 1 || view.busy ? 'disabled' : ''}>删除</button></div>`).join('')}</div>
      <div class="models-form-actions"><button class="primary-button" type="submit" ${view.busy ? 'disabled' : ''}>${view.busy ? '正在保存…' : '保存 Codex 推荐组合'}</button></div></form></section>`;
    const work = summary.work;
    const workCard = work ? `<section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot executor"></span><h2>${esc(work.roleLabel || '工作引擎')}</h2><span>${esc(kinds[work.kind] || work.kind || '引擎')}</span></div><strong>${esc(work.name || '工作引擎')}</strong><p>${esc([work.model, work.identity].filter(Boolean).join(' · '))}</p>${work.configured === false ? '<small class="model-usage-note">待连接</small>' : usageBody(work.usage, esc)}</section>` : '';
    return `<div class="${embedded ? 'models-embedded' : 'page models-page'}">${embedded ? `<div class="settings-inline-toolbar"><p class="subtle">配置默认聊天模型、订阅授权与用途默认表</p><button type="button" class="secondary-button small-button" data-action="models-refresh-usage" ${view.busy || view.refreshingUsage ? 'disabled' : ''}>${icon('refresh', 14)}${view.refreshingUsage ? '刷新中…' : '刷新额度'}</button></div>` : `${globalThis.SummonPageNav?.('models') || ''}<header class="models-header"><div><p class="models-eyebrow">SETTINGS / MODELS</p><h1>模型连接</h1><p>查看和配置 Pi 使用的模型连接与用途默认表。</p></div><button class="secondary-button" data-action="models-refresh-usage" ${view.busy || view.refreshingUsage ? 'disabled' : ''}>${icon('refresh', 15)}${view.refreshingUsage ? '正在刷新…' : '刷新额度'}</button></header>`}
      ${view.error ? `<p class="models-inline-error" role="alert">${esc(view.error)}</p>` : ''}
      <div class="models-engine-overview"><section class="models-engine-card"><div class="models-engine-title"><span class="model-source-dot"></span><h2>默认模型</h2><span>Pi</span></div><strong>${esc(active?.name || '尚未选择')}</strong><p>${esc(active?.model || '')}</p>${active?.effectivePurposes ? `<div class="models-effective-summary">${purposeLabels.map(([k, t]) => `<span class="models-effective-pill">${esc(t)}：${esc(active.effectivePurposes[k]?.id || '—')} · ${esc(active.effectivePurposes[k]?.thinking_level ?? '默认')}</span>`).join('')}</div>` : ''}${active?.configured === false ? '<small class="model-usage-note">待连接</small>' : usageBody(summary.chat?.usage, esc)}</section>${workCard}</div>
      <div class="models-configuration"><section class="models-connections"><div class="models-section-heading"><h2>模型连接</h2><span>${data.connections.length}</span></div><div class="models-add-types">${Object.entries(kinds).map(([kind, label]) => `<button data-action="models-new" data-kind="${kind}" ${view.busy ? 'disabled' : ''}>${icon('plus', 14)}${label}</button>`).join('')}</div><div class="models-connection-list">${data.connections.map(item => `<button class="models-connection ${editor?.id === item.id ? 'selected' : ''}" data-action="models-edit" data-id="${esc(item.id)}"><span class="models-provider-monogram ${item.kind}">${globalThis.SummonModelIcons.svg(item, 22)}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.model)}</small><small>${esc(kinds[item.kind])}${item.identity ? ` · ${esc(item.identity)}` : ''}</small></span>${item.configured === false ? '<small class="models-unconfigured">待连接</small>' : ''}${item.active ? '<i class="models-selected-dot" role="img" aria-label="当前默认" title="当前默认"></i>' : ''}</button>`).join('')}</div><p class="models-list-note">新建 Bot 默认跟随全局默认连接及下方用途表。</p></section>${form}</div>
      ${purposeSection}${codexSection}</div>`;
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
    if (view.editor?.id === id) view.choices = value.models || [];
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
    delete payload.preset;
    delete payload.thinkingLevels;
    delete payload.effectivePurposes;
    delete payload.effectiveBudget;
    payload.thinkingLevel = payload.thinkingLevel.trim() || null;
    const previousIds = new Set(view.data.connections.map(item => item.id));
    view.busy = true; view.error = ''; bindings.render();
    try {
      view.data = await bindings.api('/api/model-settings/connections', 'POST', payload);
      syncCodexDraft(view.data);
      const entry = view.data.connections.find(item => payload.id ? item.id === payload.id : !previousIds.has(item.id));
      view.editor = { ...entry, apiKey: '' }; view.summary = view.data;
      if (entry.kind !== 'api' && !entry.configured) await beginLogin(entry.id);
      else bindings.toast('模型配置已保存');
      await bindings.refresh?.();
    } catch (error) { view.error = error.message; bindings.toast(error.message, true); }
    finally { view.busy = false; bindings.render(); }
  }
  async function savePurposesPayload(payload, okMessage) {
    if (view.busy) return;
    view.busy = true; view.error = ''; bindings.render();
    try {
      view.data = await bindings.api('/api/model-settings/purposes', 'POST', payload);
      view.summary = view.data;
      syncCodexDraft(view.data);
      if (view.editor?.id) {
        const latest = view.data.connections.find(item => item.id === view.editor.id);
        if (latest) view.editor = { ...latest, apiKey: view.editor.apiKey || '' };
      }
      bindings.toast(okMessage);
      await bindings.refresh?.();
    } catch (error) { view.error = error.message; bindings.toast(error.message, true); }
    finally { view.busy = false; bindings.render(); }
  }
  async function submitPurposes(form) {
    const fd = new FormData(form);
    const purposeDefaults = {};
    for (const [category] of purposeCategories) {
      purposeDefaults[category] = {};
      for (const [purpose] of purposeLabels) {
        const model = String(fd.get(`pd:${category}:${purpose}:model`) || '').trim();
        const thinking = String(fd.get(`pd:${category}:${purpose}:thinking`) || '').trim();
        purposeDefaults[category][purpose] = { model, thinking_level: thinking || null };
      }
    }
    const autoGrantPurposeConnections = form.elements.autoGrantPurposeConnections?.checked !== false;
    await savePurposesPayload({ purposeDefaults, autoGrantPurposeConnections }, '用途模型默认表已保存');
  }
  async function submitCodexRecommendations() {
    const recommended = (view.codexDraft || []).map(row => ({
      model: String(row.model || '').trim(),
      efforts: String(row.efforts || '').split(/[,，\s]+/).map(item => item.trim()).filter(Boolean),
    }));
    await savePurposesPayload({ externalEngines: { codex: { recommended } } }, 'Codex 推荐组合已保存');
  }
  async function saveConnectionOverride(connId, clear = false) {
    if (clear) return savePurposesPayload({ connectionPurposes: { [connId]: null } }, '已清除单连接用途覆写');
    const panel = document.querySelector(`#model-connection-override[data-conn-id="${CSS.escape(connId)}"]`);
    if (!panel) return;
    const overrides = {};
    for (const [purpose] of purposeLabels) {
      const connection_id = panel.querySelector(`[data-ov-purpose="${purpose}"][data-ov-field="connection_id"]`)?.value.trim() || '';
      const model = panel.querySelector(`[data-ov-purpose="${purpose}"][data-ov-field="model"]`)?.value.trim() || '';
      const thinking = panel.querySelector(`[data-ov-purpose="${purpose}"][data-ov-field="thinking_level"]`)?.value.trim() || '';
      if (connection_id || model || thinking) {
        overrides[purpose] = {
          ...(connection_id ? { connection_id } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinking_level: thinking } : {}),
        };
      }
    }
    await savePurposesPayload({ connectionPurposes: { [connId]: Object.keys(overrides).length ? overrides : null } }, '单连接用途覆写已保存');
  }
  async function act(action, element, provided) {
    bindings = provided;
    if (action === 'models-quota') { view.quotaId = view.quotaId === element.dataset.id ? null : element.dataset.id; return provided.render(); }
    if (action === 'models-quota-close') return closeQuota();
    if (action === 'models-refresh-usage') return updateUsage(true);
    if (action === 'models-reload') { view.loadedAt = 0; await load(provided.api, provided.render, provided.toast, provided.refresh); return provided.render(); }
    if (action === 'models-codex-add-row') { view.codexDraft = [...(view.codexDraft || []), { model: '', efforts: 'high, xhigh' }]; return provided.render(); }
    if (action === 'models-codex-remove-row') {
      const idx = Number(element.dataset.idx);
      if (Array.isArray(view.codexDraft) && view.codexDraft.length > 1) view.codexDraft = view.codexDraft.filter((_, i) => i !== idx);
      return provided.render();
    }
    if (action === 'models-save-override') return saveConnectionOverride(element.dataset.id, false);
    if (action === 'models-clear-override') return saveConnectionOverride(element.dataset.id, true);
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
        syncCodexDraft(view.data);
        view.editor = { ...view.data.connections.find(item => item.id === view.data.importedId), apiKey: '' }; view.summary = view.data;
        await fetchChoices(view.editor.id); provided.toast(`已导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 登录`);
      }
      if (action === 'models-activate' || action === 'models-deactivate') {
        const id = action === 'models-deactivate' ? null : element.dataset.id;
        view.busy = true;
        view.data = await provided.api('/api/model-settings/active', 'POST', { id });
        syncCodexDraft(view.data);
        view.summary = view.data;
        view.quotaId = null;
        provided.toast(id === null ? '已取消 Pi 默认模型' : '已设为 Pi 默认模型');
        await provided.refresh?.();
      }
      if (action === 'models-remove') { view.busy = true; view.data = await provided.api(`/api/model-settings/connections/${encodeURIComponent(element.dataset.id)}`, 'DELETE', {}); syncCodexDraft(view.data); view.editor = selectedEditor(view.data); view.summary = view.data; }
      if (action === 'models-login') await beginLogin(element.dataset.id);
      if (action === 'models-cancel-login') { clearTimeout(loginTimer); view.login = await provided.api(`/api/model-settings/connections/${encodeURIComponent(element.dataset.id)}/login`, 'DELETE', {}); }
    } catch (error) { view.error = error.message; provided.toast(error.message, true); }
    finally { view.busy = false; provided.render(); }
  }
  document.addEventListener('click', event => { if (view.quotaId && !event.target.closest('.quota-popover,.quota-signal')) closeQuota(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && view.quotaId) closeQuota(); });
  document.addEventListener('submit', event => {
    if (event.target.id === 'model-connection-form') { event.preventDefault(); void submit(event.target); }
    if (event.target.id === 'model-purposes-form') { event.preventDefault(); void submitPurposes(event.target); }
    if (event.target.id === 'model-codex-rec-form') { event.preventDefault(); void submitCodexRecommendations(); }
  });
  document.addEventListener('input', event => {
    if (event.target.closest('#model-codex-rec-form') && event.target.dataset.codexIdx !== undefined) {
      const idx = Number(event.target.dataset.codexIdx);
      if (view.codexDraft?.[idx]) view.codexDraft[idx][event.target.dataset.codexField] = event.target.value;
      return;
    }
    if (!event.target.closest('#model-connection-form') || !view.editor || !event.target.name || event.target.name === 'preset') return;
    view.editor[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  });
  document.addEventListener('change', event => {
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
  return { sidebar, start, load, render, act, thinkingChoices, sync: summary => { if (summary) { view.summary = summary; invalidateSidebar?.(); } }, current: () => view.summary, bind: provided => { bindings = provided; } };
})();
