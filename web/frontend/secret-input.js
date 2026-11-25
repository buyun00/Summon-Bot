(() => {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const SVG = {
    shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>',
    eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.4 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6A18.3 18.3 0 0 0 2 12s3.6 8 10 8a10.6 10.6 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  };

  const MODEL_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', name: 'OpenAI', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
    { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
    { id: 'openrouter', name: 'OpenRouter', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4' },
    { id: 'openai-compatible', name: '自定义 API', provider: 'openai-compatible', api: 'openai-completions', baseUrl: '', model: '' },
  ];

  const TARGET_LABELS = {
    hub_login: '云端中枢登录（本地中枢连接器）',
    hub_register: '云端中枢注册（本地中枢连接器）',
    hub_password: '修改云端中枢密码',
    env: '本机凭据库 (runtime.env)',
    model_api_key: '本机模型凭据库 (model-credentials.json)',
    file_env: '工作区环境文件',
    session_input: '目标执行会话（直达标准输入）',
  };

  let deps = {
    api: null,
    toast: null,
    getCurrentRoom: null,
    sendSafeRoomReceipt: null,
    onAfterChange: null,
  };

  let state = null;

  function configure(options = {}) {
    deps = { ...deps, ...options };
  }

  function targetDestinationText(target) {
    if (!target || !target.kind) return TARGET_LABELS.env;
    if (target.label) return target.label;
    if (target.kind === 'hub_login' || target.kind === 'hub_register') {
      const url = target.hub_url || window.SummonHub?.state?.hubUrl || 'https://bot.lin0.org';
      return `${target.kind === 'hub_register' ? '注册' : '登录'}云端中枢 (${url})`;
    }
    if (target.kind === 'file_env') {
      return `工作区文件 ${target.path || '.env'}`;
    }
    if (target.kind === 'model_api_key') {
      return `模型连接${target.name ? ` · ${target.name}` : ''}`;
    }
    if (target.kind === 'session_input') {
      return `执行会话 ${target.session_id || ''}`.trim();
    }
    return TARGET_LABELS[target.kind] || TARGET_LABELS.env;
  }

  function wipeAndClose() {
    const root = document.getElementById('summon-secret-root');
    if (root) {
      for (const el of root.querySelectorAll('input, textarea')) {
        try { el.value = ''; } catch {}
      }
      root.remove();
    }
    state = null;
  }

  async function hubPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status, code: data.code });
    }
    return data;
  }

  async function callApi(path, method = 'GET', body) {
    if (deps.api) return deps.api(path, method, body);
    const resolved = window.SummonHub?.apiPath ? window.SummonHub.apiPath(path) : path;
    const headers = { Accept: 'application/json', 'X-Summon-Protocol': '3' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(resolved, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
    return data;
  }

  function renderSecretField({ id, label, name, isSecret, required, placeholder, defaultValue, envName, hint, autocomplete }) {
    const type = isSecret ? 'password' : 'text';
    const ac = autocomplete || (isSecret ? 'off' : 'off');
    return `<div class="secret-field">
      <div class="secret-field-head">
        <label class="secret-field-label" for="${esc(id)}">
          <span>${esc(label)}</span>
          ${required ? '<span class="secret-field-req" aria-hidden="true">*</span>' : ''}
          ${envName ? `<code class="secret-env-chip">${esc(envName)}</code>` : ''}
        </label>
        <span class="secret-field-tag">${isSecret ? '隐藏输入 · 不入 AI' : required ? '必填' : '选填'}</span>
      </div>
      <div class="secret-input-wrap">
        <input id="${esc(id)}" name="${esc(name)}" type="${type}" class="secret-input ${isSecret ? 'is-secret' : ''}"
          value="${isSecret ? '' : esc(defaultValue || '')}"
          placeholder="${esc(placeholder || (isSecret ? '输入敏感内容（直达目标，不经过 AI）' : '请输入'))}"
          autocomplete="${esc(ac)}" spellcheck="false" autocapitalize="off" autocorrect="off"
          ${required ? 'required' : ''}>
        ${isSecret ? `<button type="button" class="secret-eye-btn" data-secret-toggle="${esc(id)}" aria-label="显示或隐藏内容" aria-pressed="false">${SVG.eye}</button>` : ''}
      </div>
      ${hint ? `<p class="secret-field-hint">${esc(hint)}</p>` : ''}
    </div>`;
  }

  function renderPromptModeBody(s) {
    const prompt = s.prompt;
    const target = prompt.secret_target || { kind: 'env' };
    const fieldsHtml = (prompt.questions || []).map((q, idx) => {
      const isSecret = q.mode === 'secret' || q.secret === true;
      const ac = q.field === 'password' || q.field === 'current_password' ? 'current-password'
        : q.field === 'new_password' ? 'new-password'
        : q.field === 'username' ? 'username'
        : 'off';
      return renderSecretField({
        id: `secret-q-${idx}-${q.id}`,
        label: q.label,
        name: q.id,
        isSecret,
        required: q.required !== false,
        placeholder: q.custom_placeholder || '',
        defaultValue: isSecret ? '' : (q.default_value || ''),
        envName: q.env_name || '',
        hint: q.hint || '',
        autocomplete: ac,
      });
    }).join('');
    return `
      <div class="secret-route-banner">
        ${SVG.lock}
        <span class="secret-route-label">直达目标</span>
        ${SVG.arrow}
        <span class="secret-route-dest">${esc(targetDestinationText(target))}</span>
      </div>
      <form id="secret-modal-form" class="secret-form" autocomplete="off">
        ${fieldsHtml}
        <div id="secret-modal-error" class="secret-error" hidden></div>
      </form>`;
  }

  function renderStandaloneBody(s) {
    const tab = s.tab || 'env';
    const room = deps.getCurrentRoom?.();
    const notifyToggle = room
      ? `<label class="secret-notify-check">
          <input type="checkbox" id="secret-notify-room" ${s.notifyRoom ? 'checked' : ''}>
          <span>提交后在「${esc(room.name)}」发送脱敏回执通知 Bot（不含任何密钥值）</span>
        </label>`
      : '';

    if (tab === 'env') {
      const existing = s.envKeys || [];
      const existingHtml = `<div class="secret-existing-box">
        <div class="secret-existing-head">
          <span>已保存的本机环境变量（仅显示名称，不回显值）</span>
          <span>${existing.length} 项</span>
        </div>
        ${existing.length
          ? `<div class="secret-existing-chips">${existing.map(item => `
              <span class="secret-saved-chip">
                <span>${esc(item.name)}</span>
                <button type="button" data-secret-delete-env="${esc(item.name)}" title="删除 ${esc(item.name)}" aria-label="删除 ${esc(item.name)}">&times;</button>
              </span>`).join('')}</div>`
          : '<span class="secret-field-hint">暂未通过隐私输入窗保存环境变量</span>'}
      </div>`;
      const rows = s.kvRows || [{ name: '' }];
      return `
        <div class="secret-route-banner">
          ${SVG.lock}
          <span class="secret-route-label">直达目标</span>
          ${SVG.arrow}
          <span class="secret-route-dest">本机凭据库 (runtime.env) · 即时生效</span>
        </div>
        <form id="secret-modal-form" class="secret-form" autocomplete="off">
          <div class="secret-kv-list" id="secret-kv-list">
            ${rows.map((row, idx) => `
              <div class="secret-kv-row" data-kv-index="${idx}">
                <input type="text" class="secret-input" data-kv-name placeholder="变量名，如 GITHUB_TOKEN" value="${esc(row.name || '')}"
                  autocomplete="off" spellcheck="false" autocapitalize="off" required>
                <div class="secret-input-wrap secret-kv-val-wrap">
                  <input id="secret-kv-val-${idx}" type="password" class="secret-input is-secret" data-kv-value placeholder="密钥 / Token 值"
                    autocomplete="off" spellcheck="false" autocapitalize="off" required>
                  <button type="button" class="secret-eye-btn" data-secret-toggle="secret-kv-val-${idx}" aria-label="显示或隐藏">${SVG.eye}</button>
                </div>
                ${rows.length > 1 ? `<button type="button" class="secret-kv-remove" data-kv-remove="${idx}" aria-label="移除该项">&times;</button>` : '<span></span>'}
              </div>`).join('')}
          </div>
          <button type="button" class="secret-add-row-btn" data-secret-action="add-kv">+ 再加一项变量</button>
          ${notifyToggle}
          <div id="secret-modal-error" class="secret-error" hidden></div>
        </form>
        ${existingHtml}`;
    }

    if (tab === 'hub') {
      const hubState = window.SummonHub?.state || {};
      const sub = s.hubSub || (hubState.authenticated ? 'password' : 'login');
      const statusText = hubState.authenticated && hubState.user
        ? `当前已登录 @${hubState.user.username}（${hubState.hubUrl || 'https://bot.lin0.org'}）`
        : `未登录云端中枢（${hubState.hubUrl || 'https://bot.lin0.org'}）`;
      return `
        <div class="secret-route-banner">
          ${SVG.lock}
          <span class="secret-route-label">直达目标</span>
          ${SVG.arrow}
          <span class="secret-route-dest">${esc(statusText)}</span>
        </div>
        <div class="secret-subtabs">
          <button type="button" class="secret-subtab ${sub === 'login' ? 'active' : ''}" data-secret-hub-sub="login">登录账号</button>
          <button type="button" class="secret-subtab ${sub === 'register' ? 'active' : ''}" data-secret-hub-sub="register">邀请码注册</button>
          ${hubState.authenticated ? `<button type="button" class="secret-subtab ${sub === 'password' ? 'active' : ''}" data-secret-hub-sub="password">修改密码</button>` : ''}
        </div>
        <form id="secret-modal-form" class="secret-form" autocomplete="off">
          ${sub === 'password' ? `
            ${renderSecretField({ id: 'secret-hub-cur', label: '当前密码', name: 'currentPassword', isSecret: true, required: true, placeholder: '输入当前密码', autocomplete: 'current-password' })}
            ${renderSecretField({ id: 'secret-hub-new', label: '新密码', name: 'newPassword', isSecret: true, required: true, placeholder: '输入新密码（至少 6 位）', autocomplete: 'new-password' })}
          ` : `
            ${sub === 'register' ? renderSecretField({ id: 'secret-hub-inv', label: '邀请码', name: 'inviteCode', isSecret: false, required: true, placeholder: '输入中枢邀请码' }) : ''}
            ${renderSecretField({ id: 'secret-hub-user', label: '用户名', name: 'username', isSecret: false, required: true, placeholder: '输入中枢用户名', defaultValue: hubState.user?.username || '', autocomplete: 'username' })}
            ${renderSecretField({ id: 'secret-hub-pass', label: '密码', name: 'password', isSecret: true, required: true, placeholder: '输入登录密码', autocomplete: sub === 'register' ? 'new-password' : 'current-password' })}
            ${renderSecretField({ id: 'secret-hub-url', label: '中枢地址（选填）', name: 'hubUrl', isSecret: false, required: false, placeholder: 'https://bot.lin0.org', defaultValue: hubState.hubUrl || 'https://bot.lin0.org' })}
          `}
          ${notifyToggle}
          <div id="secret-modal-error" class="secret-error" hidden></div>
        </form>`;
    }

    if (tab === 'model') {
      const apiConns = (s.modelConnections || []).filter(c => c.kind === 'api');
      const selectedTarget = s.modelTarget || (apiConns[0]?.id ? `conn:${apiConns[0].id}` : 'preset:deepseek');
      const isPreset = selectedTarget.startsWith('preset:');
      const preset = isPreset ? (MODEL_PRESETS.find(p => p.id === selectedTarget.slice(7)) || MODEL_PRESETS[0]) : null;
      const existing = !isPreset ? apiConns.find(c => c.id === selectedTarget.slice(5)) : null;
      return `
        <div class="secret-route-banner">
          ${SVG.lock}
          <span class="secret-route-label">直达目标</span>
          ${SVG.arrow}
          <span class="secret-route-dest">本机模型凭据库 (model-credentials.json)</span>
        </div>
        <form id="secret-modal-form" class="secret-form" autocomplete="off">
          <div class="secret-field">
            <label class="secret-field-label" for="secret-model-target">模型连接</label>
            <select id="secret-model-target" name="modelTarget" class="secret-select">
              ${apiConns.length ? `<optgroup label="更新已有连接">${apiConns.map(c => `<option value="conn:${esc(c.id)}" ${selectedTarget === `conn:${c.id}` ? 'selected' : ''}>${esc(c.name)} (${esc(c.model || c.provider)})</option>`).join('')}</optgroup>` : ''}
              <optgroup label="新建 API 连接">${MODEL_PRESETS.map(p => `<option value="preset:${esc(p.id)}" ${selectedTarget === `preset:${p.id}` ? 'selected' : ''}>新建 · ${esc(p.name)}</option>`).join('')}</optgroup>
            </select>
          </div>
          ${isPreset ? `
            ${renderSecretField({ id: 'secret-model-name', label: '连接名称', name: 'name', isSecret: false, required: true, defaultValue: preset.name, placeholder: '如 DeepSeek' })}
            ${renderSecretField({ id: 'secret-model-url', label: 'API 地址', name: 'base_url', isSecret: false, required: true, defaultValue: preset.baseUrl, placeholder: 'https://api.example.com/v1' })}
            ${renderSecretField({ id: 'secret-model-id', label: '默认模型 ID', name: 'model', isSecret: false, required: true, defaultValue: preset.model, placeholder: '如 deepseek-chat' })}
          ` : `<p class="secret-field-hint">将仅更新「${esc(existing?.name || '')}」保存的 API Key，其余模型参数保持不变。</p>`}
          ${renderSecretField({ id: 'secret-model-key', label: 'API Key', name: 'api_key', isSecret: true, required: true, placeholder: 'sk-...' })}
          ${notifyToggle}
          <div id="secret-modal-error" class="secret-error" hidden></div>
        </form>`;
    }

    // file_env
    const workspaces = (s.workspaces || []).filter(w => w.write !== false);
    const wsId = s.workspaceId || workspaces[0]?.id || '';
    return `
      <div class="secret-route-banner">
        ${SVG.lock}
        <span class="secret-route-label">直达目标</span>
        ${SVG.arrow}
        <span class="secret-route-dest">工作区环境文件（直接写入磁盘，不经过 AI）</span>
      </div>
      <form id="secret-modal-form" class="secret-form" autocomplete="off">
        <div class="secret-field">
          <label class="secret-field-label" for="secret-ws-select">目标工作区</label>
          ${workspaces.length
            ? `<select id="secret-ws-select" name="workspace" class="secret-select">${workspaces.map(w => `<option value="${esc(w.id)}" ${w.id === wsId ? 'selected' : ''}>${esc(w.name || w.path)} (${esc(w.path)})</option>`).join('')}</select>`
            : '<p class="secret-field-hint">当前没有可写的工作区，请先绑定工作区或改用「环境变量 / Key」。</p>'}
        </div>
        ${renderSecretField({ id: 'secret-file-path', label: '相对路径', name: 'path', isSecret: false, required: true, defaultValue: s.filePath || '.env', placeholder: '.env 或 .env.local' })}
        ${renderSecretField({ id: 'secret-file-key', label: '变量名', name: 'env_name', isSecret: false, required: true, placeholder: '如 DATABASE_URL 或 STRIPE_SECRET_KEY' })}
        ${renderSecretField({ id: 'secret-file-val', label: '敏感值', name: 'env_value', isSecret: true, required: true, placeholder: '输入将直接写入目标文件的值' })}
        ${notifyToggle}
        <div id="secret-modal-error" class="secret-error" hidden></div>
      </form>`;
  }

  function render() {
    if (!state) return;
    let root = document.getElementById('summon-secret-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'summon-secret-root';
      root.className = 'secret-overlay';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      document.body.appendChild(root);
    }

    const isPrompt = state.mode === 'prompt';
    const title = isPrompt ? (state.prompt.title || '隐私凭据输入') : '独立隐私输入窗';
    const subtitle = isPrompt
      ? (state.prompt.description || '敏感内容直达目标，绝不进入聊天记录或上传给 AI 分析。')
      : '一次输入，直达本机凭据库、云端中枢或目标服务，全程不经过 AI。';
    const submitLabel = isPrompt
      ? (state.prompt.submit_label || (state.prompt.secret_target?.kind === 'hub_login' ? '安全登录' : '安全提交'))
      : (state.tab === 'hub' ? (state.hubSub === 'password' ? '安全修改' : state.hubSub === 'register' ? '安全注册' : '安全登录') : '安全保存');

    const tabsHtml = !isPrompt ? `
      <div class="secret-tabs" role="tablist">
        <button type="button" class="secret-tab ${state.tab === 'env' ? 'active' : ''}" data-secret-tab="env">环境变量 / Key</button>
        <button type="button" class="secret-tab ${state.tab === 'hub' ? 'active' : ''}" data-secret-tab="hub">云端中枢</button>
        <button type="button" class="secret-tab ${state.tab === 'model' ? 'active' : ''}" data-secret-tab="model">模型 Key</button>
        <button type="button" class="secret-tab ${state.tab === 'file_env' ? 'active' : ''}" data-secret-tab="file_env">工作区 .env</button>
      </div>` : '';

    root.innerHTML = `
      <div class="secret-window">
        <div class="secret-head">
          <span class="secret-shield-icon">${SVG.shield}</span>
          <div class="secret-head-copy">
            <div class="secret-head-title-row">
              <h2 class="secret-title">${esc(title)}</h2>
              <span class="secret-zero-ai-pill">${SVG.lock} 不经过 AI</span>
            </div>
            <p class="secret-subtitle">${esc(subtitle)}</p>
          </div>
          <button type="button" class="secret-close-btn" data-secret-action="close" aria-label="关闭隐私输入窗">${SVG.close}</button>
        </div>
        ${tabsHtml}
        <div class="secret-body">
          ${isPrompt ? renderPromptModeBody(state) : renderStandaloneBody(state)}
        </div>
        <div class="secret-foot">
          <span class="secret-foot-note">${SVG.lock} 提交后自动清空内存</span>
          <button type="button" class="secondary-button secret-cancel-btn" data-secret-action="close" ${state.busy ? 'disabled' : ''}>取消</button>
          <button type="submit" form="secret-modal-form" class="secret-submit-btn" ${state.busy ? 'disabled' : ''}>
            ${SVG.lock}
            <span>${state.busy ? '正在安全提交…' : esc(submitLabel)}</span>
          </button>
        </div>
      </div>`;

    bindEvents(root);
    const firstInput = root.querySelector('.secret-input:not([value]), .secret-input[type="password"], .secret-input');
    if (firstInput && !state.busy) setTimeout(() => firstInput.focus(), 20);
  }

  function showError(root, message) {
    const el = root.querySelector('#secret-modal-error');
    if (!el) return;
    el.textContent = message || '提交失败，请检查后重试';
    el.hidden = false;
  }

  async function handlePromptSubmit(root, form) {
    const prompt = state.prompt;
    const target = prompt.secret_target || { kind: 'env' };
    const questions = prompt.questions || [];
    const values = {};
    const answers = [];
    const summaryParts = [];
    const envEntries = [];

    for (const q of questions) {
      const input = form.elements.namedItem(q.id);
      const val = typeof input?.value === 'string' ? input.value : '';
      const trimmed = val.trim();
      const isSecret = q.mode === 'secret' || q.secret === true;
      if (q.required !== false && !trimmed) {
        throw new Error(`请填写「${q.label}」`);
      }
      if (!trimmed) continue;
      const semanticKey = q.field || q.env_name || q.id;
      values[semanticKey] = isSecret ? val : trimmed;
      if (q.env_name) envEntries.push({ name: q.env_name, value: val });
      answers.push({
        question_id: q.id,
        label: q.label,
        selected_ids: [],
        selected_labels: [],
        ...(isSecret ? { redacted: true } : { custom_text: trimmed }),
      });
      summaryParts.push(isSecret ? `${q.label}：已安全直达（未经过 AI）` : `${q.label}：${trimmed}`);
    }

    let delivery;
    if (target.kind === 'hub_login') {
      const hubUrl = values.hub_url || target.hub_url || window.SummonHub?.state?.hubUrl || undefined;
      const username = values.username || '';
      const password = values.password || '';
      if (!username || !password) throw new Error('请输入用户名和密码');
      const res = await hubPost('/hub/auth/login', { username, password, ...(hubUrl ? { hubUrl } : {}) });
      await window.SummonHub?.applyAuthResult?.(res);
      delivery = {
        target_kind: 'hub_login',
        target_label: targetDestinationText(target),
        configured_keys: ['云端中枢登录'],
        detail: `已安全登录云端中枢（@${res?.user?.username || username}）`,
      };
    } else if (target.kind === 'hub_register') {
      const hubUrl = values.hub_url || target.hub_url || window.SummonHub?.state?.hubUrl || undefined;
      const inviteCode = values.invite_code || values.inviteCode || '';
      const username = values.username || '';
      const password = values.password || '';
      const displayName = values.display_name || values.displayName || undefined;
      if (!inviteCode || !username || !password) throw new Error('请填写邀请码、用户名和密码');
      const res = await hubPost('/hub/auth/register', {
        inviteCode, username, password,
        ...(displayName ? { displayName } : {}),
        ...(hubUrl ? { hubUrl } : {}),
      });
      await window.SummonHub?.applyAuthResult?.(res);
      delivery = {
        target_kind: 'hub_register',
        target_label: targetDestinationText(target),
        configured_keys: ['云端中枢注册'],
        detail: `已安全注册并登录云端中枢（@${res?.user?.username || username}）`,
      };
    } else if (target.kind === 'hub_password') {
      const currentPassword = values.current_password || values.currentPassword || '';
      const newPassword = values.new_password || values.newPassword || '';
      if (!currentPassword || !newPassword) throw new Error('请输入当前密码和新密码');
      await hubPost('/hub/auth/password', { currentPassword, newPassword });
      delivery = {
        target_kind: 'hub_password',
        target_label: targetDestinationText(target),
        configured_keys: ['云端中枢密码'],
        detail: '已安全更新云端中枢密码',
      };
    } else {
      const payload = {
        target,
        fields: values,
        ...(envEntries.length ? { entries: envEntries } : {}),
      };
      const res = await callApi('/api/secrets/deliver', 'POST', payload);
      delivery = {
        target_kind: res.target_kind || target.kind,
        target_label: res.target_label || targetDestinationText(target),
        configured_keys: Array.isArray(res.configured_keys) ? res.configured_keys : [],
        detail: res.detail || '已安全直达目标',
      };
    }

    const onSubmitted = state.onSubmitted;
    wipeAndClose();
    deps.toast?.(delivery.detail || '已通过隐私通道安全提交');
    deps.onAfterChange?.(delivery);
    if (onSubmitted) {
      await onSubmitted({
        answers,
        secret_delivery: delivery,
        summaryText: `已通过隐私输入窗安全完成「${prompt.title || delivery.target_label}」（${summaryParts.join('，')}）`,
      });
    }
  }

  async function handleStandaloneSubmit(root, form) {
    const tab = state.tab || 'env';
    const notifyRoom = Boolean(root.querySelector('#secret-notify-room')?.checked);
    let delivery;
    let receiptText = '';

    if (tab === 'env') {
      const rows = [...root.querySelectorAll('.secret-kv-row')];
      const entries = [];
      for (const row of rows) {
        const name = row.querySelector('[data-kv-name]')?.value?.trim() || '';
        const value = row.querySelector('[data-kv-value]')?.value ?? '';
        if (!name && !value) continue;
        if (!name || !value) throw new Error('请同时填写变量名和密钥值');
        entries.push({ name, value });
      }
      if (!entries.length) throw new Error('请至少填写一项环境变量凭据');
      delivery = await callApi('/api/secrets/deliver', 'POST', { target: { kind: 'env' }, entries });
      receiptText = `已通过隐私输入窗安全配置环境变量：${delivery.configured_keys.join('、')}（值已直达本机 runtime.env 并生效，未经过 AI）`;
    } else if (tab === 'hub') {
      const hubState = window.SummonHub?.state || {};
      const sub = state.hubSub || (hubState.authenticated ? 'password' : 'login');
      const fd = new FormData(form);
      const data = Object.fromEntries(fd.entries());
      if (sub === 'password') {
        await hubPost('/hub/auth/password', { currentPassword: data.currentPassword, newPassword: data.newPassword });
        delivery = { target_kind: 'hub_password', detail: '已安全修改云端中枢密码' };
        receiptText = '已通过隐私输入窗安全更新云端中枢密码（未经过 AI）。';
      } else if (sub === 'register') {
        const res = await hubPost('/hub/auth/register', {
          inviteCode: String(data.inviteCode || '').trim(),
          username: String(data.username || '').trim(),
          password: String(data.password || ''),
          ...(String(data.hubUrl || '').trim() ? { hubUrl: String(data.hubUrl).trim() } : {}),
        });
        await window.SummonHub?.applyAuthResult?.(res);
        delivery = { target_kind: 'hub_register', detail: `已安全注册并登录云端中枢（@${res?.user?.username || data.username}）` };
        receiptText = `已通过隐私输入窗安全注册并登录云端中枢（用户：${res?.user?.username || data.username}，密码未经过 AI）。`;
      } else {
        const res = await hubPost('/hub/auth/login', {
          username: String(data.username || '').trim(),
          password: String(data.password || ''),
          ...(String(data.hubUrl || '').trim() ? { hubUrl: String(data.hubUrl).trim() } : {}),
        });
        await window.SummonHub?.applyAuthResult?.(res);
        delivery = { target_kind: 'hub_login', detail: `已安全登录云端中枢（@${res?.user?.username || data.username}）` };
        receiptText = `已通过隐私输入窗安全登录云端中枢（用户：${res?.user?.username || data.username}，密码未经过 AI）。`;
      }
    } else if (tab === 'model') {
      const fd = new FormData(form);
      const data = Object.fromEntries(fd.entries());
      const sel = String(data.modelTarget || state.modelTarget || '');
      const target = { kind: 'model_api_key' };
      const fields = { api_key: String(data.api_key || '') };
      if (sel.startsWith('conn:')) {
        target.connection_id = sel.slice(5);
      } else if (sel.startsWith('preset:')) {
        target.provider = sel.slice(7);
        fields.name = String(data.name || '').trim();
        fields.base_url = String(data.base_url || '').trim();
        fields.model = String(data.model || '').trim();
      }
      delivery = await callApi('/api/secrets/deliver', 'POST', { target, fields });
      receiptText = `已通过隐私输入窗安全保存模型凭据（${delivery.target_label}，API Key 未经过 AI）。`;
    } else if (tab === 'file_env') {
      const fd = new FormData(form);
      const data = Object.fromEntries(fd.entries());
      const workspace = String(data.workspace || state.workspaceId || '').trim();
      const path = String(data.path || '.env').trim();
      const name = String(data.env_name || '').trim();
      const value = String(data.env_value || '');
      if (!workspace) throw new Error('请选择目标工作区');
      if (!name || !value) throw new Error('请填写变量名和敏感值');
      delivery = await callApi('/api/secrets/deliver', 'POST', {
        target: { kind: 'file_env', workspace, path },
        entries: [{ name, value }],
      });
      receiptText = `已通过隐私输入窗安全写入工作区环境文件 ${path}（变量：${name}，值未经过 AI）。`;
    }

    wipeAndClose();
    deps.toast?.(delivery?.detail || '已通过隐私通道安全保存');
    deps.onAfterChange?.(delivery);
    if (notifyRoom && receiptText && deps.sendSafeRoomReceipt) {
      await deps.sendSafeRoomReceipt(receiptText);
    }
  }

  function bindEvents(root) {
    root.onclick = async event => {
      if (event.target === root) {
        if (!state?.busy) wipeAndClose();
        return;
      }
      const toggleBtn = event.target.closest('[data-secret-toggle]');
      if (toggleBtn) {
        const input = root.querySelector(`#${CSS.escape(toggleBtn.dataset.secretToggle)}`);
        if (input) {
          const showing = input.type === 'text';
          input.type = showing ? 'password' : 'text';
          toggleBtn.innerHTML = showing ? SVG.eye : SVG.eyeOff;
          toggleBtn.setAttribute('aria-pressed', String(!showing));
        }
        return;
      }
      const actionBtn = event.target.closest('[data-secret-action]');
      if (actionBtn) {
        const action = actionBtn.dataset.secretAction;
        if (action === 'close' && !state?.busy) wipeAndClose();
        if (action === 'add-kv' && state) {
          const currentNames = [...root.querySelectorAll('[data-kv-name]')].map(el => ({ name: el.value }));
          state.kvRows = [...currentNames, { name: '' }];
          render();
        }
        return;
      }
      const removeKv = event.target.closest('[data-kv-remove]');
      if (removeKv && state) {
        const idx = Number(removeKv.dataset.kvRemove);
        const currentNames = [...root.querySelectorAll('[data-kv-name]')].map(el => ({ name: el.value }));
        state.kvRows = currentNames.filter((_, i) => i !== idx);
        if (!state.kvRows.length) state.kvRows = [{ name: '' }];
        render();
        return;
      }
      const tabBtn = event.target.closest('[data-secret-tab]');
      if (tabBtn && state && !state.busy) {
        state.tab = tabBtn.dataset.secretTab;
        render();
        return;
      }
      const hubSubBtn = event.target.closest('[data-secret-hub-sub]');
      if (hubSubBtn && state && !state.busy) {
        state.hubSub = hubSubBtn.dataset.secretHubSub;
        render();
        return;
      }
      const delEnvBtn = event.target.closest('[data-secret-delete-env]');
      if (delEnvBtn && state && !state.busy) {
        const name = delEnvBtn.dataset.secretDeleteEnv;
        if (!confirm(`确定从本机凭据库移除环境变量 ${name} 吗？`)) return;
        try {
          await callApi(`/api/secrets/env/${encodeURIComponent(name)}`, 'DELETE');
          state.envKeys = (state.envKeys || []).filter(k => k.name !== name);
          deps.toast?.(`已移除环境变量 ${name}`);
          render();
        } catch (err) {
          showError(root, err.message);
        }
      }
    };

    const modelSelect = root.querySelector('#secret-model-target');
    if (modelSelect && state) {
      modelSelect.onchange = () => {
        state.modelTarget = modelSelect.value;
        render();
      };
    }
    const wsSelect = root.querySelector('#secret-ws-select');
    if (wsSelect && state) {
      wsSelect.onchange = () => { state.workspaceId = wsSelect.value; };
    }
    const notifyBox = root.querySelector('#secret-notify-room');
    if (notifyBox && state) {
      notifyBox.onchange = () => { state.notifyRoom = notifyBox.checked; };
    }

    const form = root.querySelector('#secret-modal-form');
    if (form) {
      form.onsubmit = async event => {
        event.preventDefault();
        if (!state || state.busy) return;
        const errEl = root.querySelector('#secret-modal-error');
        if (errEl) errEl.hidden = true;
        state.busy = true;
        const submitBtn = root.querySelector('.secret-submit-btn');
        if (submitBtn) submitBtn.disabled = true;
        try {
          if (state.mode === 'prompt') {
            await handlePromptSubmit(root, form);
          } else {
            await handleStandaloneSubmit(root, form);
          }
        } catch (error) {
          if (state) {
            state.busy = false;
            if (submitBtn) submitBtn.disabled = false;
            showError(root, error.message);
          }
        }
      };
    }
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state && !state.busy) {
      event.preventDefault();
      wipeAndClose();
    }
  });

  function openForPrompt(message, { onSubmitted } = {}) {
    if (!message?.prompt || message.prompt.kind !== 'secret') return;
    wipeAndClose();
    state = {
      mode: 'prompt',
      messageId: message.id,
      prompt: message.prompt,
      onSubmitted,
      busy: false,
    };
    render();
  }

  async function openStandalone({ tab = 'env', hubSub = null, notifyRoom = false } = {}) {
    wipeAndClose();
    state = {
      mode: 'standalone',
      tab,
      hubSub,
      notifyRoom,
      kvRows: [{ name: '' }],
      envKeys: [],
      modelConnections: [],
      workspaces: [],
      busy: false,
    };
    render();
    const [envRes, modelRes, wsRes] = await Promise.allSettled([
      callApi('/api/secrets/env'),
      callApi('/api/model-settings'),
      callApi('/api/workspaces'),
    ]);
    if (!state || state.mode !== 'standalone') return;
    if (envRes.status === 'fulfilled') state.envKeys = envRes.value?.keys || [];
    if (modelRes.status === 'fulfilled') state.modelConnections = modelRes.value?.connections || [];
    if (wsRes.status === 'fulfilled') state.workspaces = wsRes.value?.items || [];
    render();
  }

  function isOpen() {
    return Boolean(state);
  }

  window.SummonSecretInput = Object.freeze({
    configure,
    openForPrompt,
    openStandalone,
    close: wipeAndClose,
    isOpen,
    targetDestinationText,
  });
})();
