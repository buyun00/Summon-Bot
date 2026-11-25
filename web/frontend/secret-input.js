(() => {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const SVG = {
    shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
    lock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>',
    eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.4 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6A18.3 18.3 0 0 0 2 12s3.6 8 10 8a10.6 10.6 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  };

  const MODEL_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', name: 'OpenAI', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
    { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
    { id: 'openrouter', name: 'OpenRouter', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4' },
    { id: 'openai-compatible', name: '自定义 API', provider: 'openai-compatible', api: 'openai-completions', baseUrl: '', model: '' },
  ];

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

  function compactTargetHint(target) {
    if (!target?.kind) return '';
    if (target.kind === 'hub_login' || target.kind === 'hub_register' || target.kind === 'hub_password') {
      const raw = target.hub_url || window.SummonHub?.state?.hubUrl || '';
      return raw.replace(/^https?:\/\//, '');
    }
    if (target.kind === 'env') return 'runtime.env';
    if (target.kind === 'file_env') return target.path || '.env';
    if (target.kind === 'model_api_key') return target.name || '';
    if (target.kind === 'session_input') return target.label || '';
    return target.label || '';
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

  function renderSecretField({ id, label, name, isSecret, required, placeholder, defaultValue, envName, autocomplete }) {
    const type = isSecret ? 'password' : 'text';
    const ac = autocomplete || 'off';
    const showEnvChip = envName && envName !== label;
    return `<div class="secret-field">
      <div class="secret-field-head">
        <label class="secret-field-label" for="${esc(id)}">
          <span>${esc(label)}</span>
          ${showEnvChip ? `<code class="secret-env-chip">${esc(envName)}</code>` : ''}
        </label>
        ${!required ? '<span class="secret-field-tag">选填</span>' : ''}
      </div>
      <div class="secret-input-wrap">
        <input id="${esc(id)}" name="${esc(name)}" type="${type}" class="secret-input ${isSecret ? 'is-secret' : ''}"
          value="${isSecret ? '' : esc(defaultValue || '')}"
          placeholder="${esc(placeholder || '')}"
          autocomplete="${esc(ac)}" spellcheck="false" autocapitalize="off" autocorrect="off"
          ${required ? 'required' : ''}>
        ${isSecret ? `<button type="button" class="secret-eye-btn" data-secret-toggle="${esc(id)}" aria-label="显示或隐藏" aria-pressed="false">${SVG.eye}</button>` : ''}
      </div>
    </div>`;
  }

  function renderPromptModeBody(s) {
    const prompt = s.prompt;
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
        autocomplete: ac,
      });
    }).join('');
    return `
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
          <span>通知「${esc(room.name)}」</span>
        </label>`
      : '';

    if (tab === 'env') {
      const existing = s.envKeys || [];
      const existingHtml = existing.length ? `<div class="secret-existing-box">
        <div class="secret-existing-head"><span>已保存</span><span>${existing.length}</span></div>
        <div class="secret-existing-chips">${existing.map(item => `
          <span class="secret-saved-chip">
            <span>${esc(item.name)}</span>
            <button type="button" data-secret-delete-env="${esc(item.name)}" aria-label="删除 ${esc(item.name)}">&times;</button>
          </span>`).join('')}</div>
      </div>` : '';
      const rows = s.kvRows || [{ name: '' }];
      return `
        <form id="secret-modal-form" class="secret-form" autocomplete="off">
          <div class="secret-kv-list" id="secret-kv-list">
            ${rows.map((row, idx) => `
              <div class="secret-kv-row" data-kv-index="${idx}">
                <input type="text" class="secret-input" data-kv-name placeholder="变量名" value="${esc(row.name || '')}"
                  autocomplete="off" spellcheck="false" autocapitalize="off" required>
                <div class="secret-input-wrap secret-kv-val-wrap">
                  <input id="secret-kv-val-${idx}" type="password" class="secret-input is-secret" data-kv-value placeholder="值"
                    autocomplete="off" spellcheck="false" autocapitalize="off" required>
                  <button type="button" class="secret-eye-btn" data-secret-toggle="secret-kv-val-${idx}" aria-label="显示或隐藏">${SVG.eye}</button>
                </div>
                ${rows.length > 1 ? `<button type="button" class="secret-kv-remove" data-kv-remove="${idx}" aria-label="移除">&times;</button>` : '<span></span>'}
              </div>`).join('')}
          </div>
          <button type="button" class="secret-add-row-btn" data-secret-action="add-kv">+ 添加</button>
          ${notifyToggle}
          <div id="secret-modal-error" class="secret-error" hidden></div>
        </form>
        ${existingHtml}`;
    }

    if (tab === 'hub') {
      const hubState = window.SummonHub?.state || {};
      const sub = s.hubSub || (hubState.authenticated ? 'password' : 'login');
      return `
        <div class="secret-subtabs">
          <button type="button" class="secret-subtab ${sub === 'login' ? 'active' : ''}" data-secret-hub-sub="login">登录</button>
          <button type="button" class="secret-subtab ${sub === 'register' ? 'active' : ''}" data-secret-hub-sub="register">注册</button>
          ${hubState.authenticated ? `<button type="button" class="secret-subtab ${sub === 'password' ? 'active' : ''}" data-secret-hub-sub="password">改密码</button>` : ''}
        </div>
        <form id="secret-modal-form" class="secret-form" autocomplete="off">
          ${sub === 'password' ? `
            ${renderSecretField({ id: 'secret-hub-cur', label: '当前密码', name: 'currentPassword', isSecret: true, required: true, autocomplete: 'current-password' })}
            ${renderSecretField({ id: 'secret-hub-new', label: '新密码', name: 'newPassword', isSecret: true, required: true, autocomplete: 'new-password' })}
          ` : `
            ${sub === 'register' ? renderSecretField({ id: 'secret-hub-inv', label: '邀请码', name: 'inviteCode', isSecret: false, required: true }) : ''}
            ${renderSecretField({ id: 'secret-hub-user', label: '用户名', name: 'username', isSecret: false, required: true, defaultValue: hubState.user?.username || '', autocomplete: 'username' })}
            ${renderSecretField({ id: 'secret-hub-pass', label: '密码', name: 'password', isSecret: true, required: true, autocomplete: sub === 'register' ? 'new-password' : 'current-password' })}
            ${renderSecretField({ id: 'secret-hub-url', label: '中枢地址', name: 'hubUrl', isSecret: false, required: false, defaultValue: hubState.hubUrl || 'https://bot.lin0.org' })}
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
      return `
        <form id="secret-modal-form" class="secret-form" autocomplete="off">
          <div class="secret-field">
            <label class="secret-field-label" for="secret-model-target">连接</label>
            <select id="secret-model-target" name="modelTarget" class="secret-select">
              ${apiConns.length ? `<optgroup label="已有连接">${apiConns.map(c => `<option value="conn:${esc(c.id)}" ${selectedTarget === `conn:${c.id}` ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>` : ''}
              <optgroup label="新建">${MODEL_PRESETS.map(p => `<option value="preset:${esc(p.id)}" ${selectedTarget === `preset:${p.id}` ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>
            </select>
          </div>
          ${isPreset ? `
            ${renderSecretField({ id: 'secret-model-name', label: '名称', name: 'name', isSecret: false, required: true, defaultValue: preset.name })}
            ${renderSecretField({ id: 'secret-model-url', label: 'API 地址', name: 'base_url', isSecret: false, required: true, defaultValue: preset.baseUrl })}
            ${renderSecretField({ id: 'secret-model-id', label: '模型 ID', name: 'model', isSecret: false, required: true, defaultValue: preset.model })}
          ` : ''}
          ${renderSecretField({ id: 'secret-model-key', label: 'API Key', name: 'api_key', isSecret: true, required: true, placeholder: 'sk-...' })}
          ${notifyToggle}
          <div id="secret-modal-error" class="secret-error" hidden></div>
        </form>`;
    }

    const workspaces = (s.workspaces || []).filter(w => w.write !== false);
    const wsId = s.workspaceId || workspaces[0]?.id || '';
    return `
      <form id="secret-modal-form" class="secret-form" autocomplete="off">
        <div class="secret-field">
          <label class="secret-field-label" for="secret-ws-select">工作区</label>
          ${workspaces.length
            ? `<select id="secret-ws-select" name="workspace" class="secret-select">${workspaces.map(w => `<option value="${esc(w.id)}" ${w.id === wsId ? 'selected' : ''}>${esc(w.name || w.path)}</option>`).join('')}</select>`
            : '<p class="secret-field-hint">暂无可写工作区</p>'}
        </div>
        ${renderSecretField({ id: 'secret-file-path', label: '文件', name: 'path', isSecret: false, required: true, defaultValue: s.filePath || '.env', placeholder: '.env' })}
        ${renderSecretField({ id: 'secret-file-key', label: '变量名', name: 'env_name', isSecret: false, required: true })}
        ${renderSecretField({ id: 'secret-file-val', label: '值', name: 'env_value', isSecret: true, required: true })}
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
    const title = isPrompt ? (state.prompt.title || '隐私输入') : '隐私输入';
    const targetHint = isPrompt ? compactTargetHint(state.prompt.secret_target) : '';
    const submitLabel = isPrompt
      ? (state.prompt.submit_label || (state.prompt.secret_target?.kind === 'hub_login' ? '登录' : '确定'))
      : (state.tab === 'hub' ? (state.hubSub === 'password' ? '修改' : state.hubSub === 'register' ? '注册' : '登录') : '保存');

    const tabsHtml = !isPrompt ? `
      <div class="secret-tabs" role="tablist">
        <button type="button" class="secret-tab ${state.tab === 'env' ? 'active' : ''}" data-secret-tab="env">环境变量</button>
        <button type="button" class="secret-tab ${state.tab === 'hub' ? 'active' : ''}" data-secret-tab="hub">云端中枢</button>
        <button type="button" class="secret-tab ${state.tab === 'model' ? 'active' : ''}" data-secret-tab="model">模型 Key</button>
        <button type="button" class="secret-tab ${state.tab === 'file_env' ? 'active' : ''}" data-secret-tab="file_env">.env 文件</button>
      </div>` : '';

    root.innerHTML = `
      <div class="secret-window">
        <div class="secret-head">
          <div class="secret-head-copy">
            <div class="secret-head-title-row">
              <span class="secret-shield-dot">${SVG.shield}</span>
              <h2 class="secret-title">${esc(title)}</h2>
              <span class="secret-zero-ai-pill">隐私输入</span>
            </div>
            ${targetHint ? `<p class="secret-subtitle">${esc(targetHint)}</p>` : ''}
          </div>
          <button type="button" class="secret-close-btn" data-secret-action="close" aria-label="关闭">${SVG.close}</button>
        </div>
        ${tabsHtml}
        <div class="secret-body">
          ${isPrompt ? renderPromptModeBody(state) : renderStandaloneBody(state)}
        </div>
        <div class="secret-foot">
          <button type="button" class="secondary-button secret-cancel-btn" data-secret-action="close">取消</button>
          <button type="submit" form="secret-modal-form" class="secret-submit-btn">${esc(submitLabel)}</button>
        </div>
      </div>`;

    bindEvents(root);
    const firstEmpty = [...root.querySelectorAll('.secret-input')].find(el => !el.value) || root.querySelector('.secret-input');
    if (firstEmpty) setTimeout(() => firstEmpty.focus(), 20);
  }

  function showError(root, message) {
    const el = root.querySelector('#secret-modal-error');
    if (!el) return;
    el.textContent = message || '请检查输入';
    el.hidden = false;
  }

  function collectPromptSubmission(form) {
    const prompt = state.prompt;
    const target = prompt.secret_target || { kind: 'env' };
    const questions = prompt.questions || [];
    const values = {};
    const answers = [];
    const visibleValues = [];
    const envEntries = [];

    for (const q of questions) {
      const input = form.elements.namedItem(q.id);
      const val = typeof input?.value === 'string' ? input.value : '';
      const trimmed = val.trim();
      const isSecret = q.mode === 'secret' || q.secret === true;
      if (q.required !== false && !trimmed) {
        throw new Error(`请填写${q.label}`);
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
      if (!isSecret) visibleValues.push(trimmed);
    }

    if (target.kind === 'hub_login' && (!values.username || !values.password)) {
      throw new Error('请输入用户名和密码');
    }
    if (target.kind === 'hub_register' && (!(values.invite_code || values.inviteCode) || !values.username || !values.password)) {
      throw new Error('请填写邀请码、用户名和密码');
    }
    if (target.kind === 'hub_password' && (!(values.current_password || values.currentPassword) || !(values.new_password || values.newPassword))) {
      throw new Error('请输入当前密码和新密码');
    }

    return { prompt, target, values, answers, visibleValues, envEntries };
  }

  async function executePromptSubmission({ prompt, target, values, answers, visibleValues, envEntries }, callbacks) {
    callbacks.onStart?.();
    try {
      let delivery;
      if (target.kind === 'hub_login') {
        const hubUrl = values.hub_url || target.hub_url || window.SummonHub?.state?.hubUrl || undefined;
        const res = await hubPost('/hub/auth/login', {
          username: values.username,
          password: values.password,
          ...(hubUrl ? { hubUrl } : {}),
        });
        await window.SummonHub?.applyAuthResult?.(res);
        delivery = { target_kind: 'hub_login', detail: `已登录 ${res?.user?.username || values.username}` };
      } else if (target.kind === 'hub_register') {
        const hubUrl = values.hub_url || target.hub_url || window.SummonHub?.state?.hubUrl || undefined;
        const res = await hubPost('/hub/auth/register', {
          inviteCode: values.invite_code || values.inviteCode,
          username: values.username,
          password: values.password,
          ...(values.display_name || values.displayName ? { displayName: values.display_name || values.displayName } : {}),
          ...(hubUrl ? { hubUrl } : {}),
        });
        await window.SummonHub?.applyAuthResult?.(res);
        delivery = { target_kind: 'hub_register', detail: `已注册 ${res?.user?.username || values.username}` };
      } else if (target.kind === 'hub_password') {
        await hubPost('/hub/auth/password', {
          currentPassword: values.current_password || values.currentPassword,
          newPassword: values.new_password || values.newPassword,
        });
        delivery = { target_kind: 'hub_password', detail: '已修改密码' };
      } else {
        const res = await callApi('/api/secrets/deliver', 'POST', {
          target,
          fields: values,
          ...(envEntries.length ? { entries: envEntries } : {}),
        });
        delivery = {
          target_kind: res.target_kind || target.kind,
          configured_keys: Array.isArray(res.configured_keys) ? res.configured_keys : [],
          detail: res.detail || '已提交',
        };
      }

      const label = prompt.title || compactTargetHint(target) || '隐私输入';
      const extra = visibleValues.length
        ? `（${visibleValues.join(' · ')}）`
        : (delivery.configured_keys?.length ? `（${delivery.configured_keys.join('、')}）` : '');
      const summaryText = `已提交：${label}${extra}`;

      deps.onAfterChange?.(delivery);
      await callbacks.onSubmitted?.({ answers, secret_delivery: delivery, summaryText });
    } catch (error) {
      callbacks.onError?.(error);
      deps.toast?.(error.message || '提交失败，请重试', true);
    } finally {
      for (const k of Object.keys(values)) values[k] = '';
      for (const item of envEntries) item.value = '';
    }
  }

  function collectStandaloneSubmission(root, form) {
    const tab = state.tab || 'env';
    const notifyRoom = Boolean(root.querySelector('#secret-notify-room')?.checked);
    if (tab === 'env') {
      const entries = [];
      for (const row of root.querySelectorAll('.secret-kv-row')) {
        const name = row.querySelector('[data-kv-name]')?.value?.trim() || '';
        const value = row.querySelector('[data-kv-value]')?.value ?? '';
        if (!name && !value) continue;
        if (!name || !value) throw new Error('请填写变量名和值');
        entries.push({ name, value });
      }
      if (!entries.length) throw new Error('请填写至少一项');
      return { tab, notifyRoom, entries };
    }
    const data = Object.fromEntries(new FormData(form).entries());
    if (tab === 'hub') {
      const hubState = window.SummonHub?.state || {};
      const sub = state.hubSub || (hubState.authenticated ? 'password' : 'login');
      return { tab, notifyRoom, sub, data };
    }
    if (tab === 'model') {
      return { tab, notifyRoom, sel: String(data.modelTarget || state.modelTarget || ''), data };
    }
    const workspace = String(data.workspace || state.workspaceId || '').trim();
    const path = String(data.path || '.env').trim();
    const name = String(data.env_name || '').trim();
    const value = String(data.env_value || '');
    if (!workspace) throw new Error('请选择工作区');
    if (!name || !value) throw new Error('请填写变量名和值');
    return { tab, notifyRoom, workspace, path, name, value };
  }

  async function executeStandaloneSubmission(collected) {
    try {
      let delivery;
      let receiptText = '';
      if (collected.tab === 'env') {
        delivery = await callApi('/api/secrets/deliver', 'POST', { target: { kind: 'env' }, entries: collected.entries });
        receiptText = `已配置：${delivery.configured_keys.join('、')}`;
      } else if (collected.tab === 'hub') {
        const { sub, data } = collected;
        if (sub === 'password') {
          await hubPost('/hub/auth/password', { currentPassword: data.currentPassword, newPassword: data.newPassword });
          delivery = { target_kind: 'hub_password', detail: '已修改密码' };
          receiptText = '已修改云端中枢密码';
        } else if (sub === 'register') {
          const res = await hubPost('/hub/auth/register', {
            inviteCode: String(data.inviteCode || '').trim(),
            username: String(data.username || '').trim(),
            password: String(data.password || ''),
            ...(String(data.hubUrl || '').trim() ? { hubUrl: String(data.hubUrl).trim() } : {}),
          });
          await window.SummonHub?.applyAuthResult?.(res);
          const u = res?.user?.username || data.username;
          delivery = { target_kind: 'hub_register', detail: `已登录 ${u}` };
          receiptText = `已注册并登录云端中枢（${u}）`;
        } else {
          const res = await hubPost('/hub/auth/login', {
            username: String(data.username || '').trim(),
            password: String(data.password || ''),
            ...(String(data.hubUrl || '').trim() ? { hubUrl: String(data.hubUrl).trim() } : {}),
          });
          await window.SummonHub?.applyAuthResult?.(res);
          const u = res?.user?.username || data.username;
          delivery = { target_kind: 'hub_login', detail: `已登录 ${u}` };
          receiptText = `已登录云端中枢（${u}）`;
        }
      } else if (collected.tab === 'model') {
        const { sel, data } = collected;
        const target = { kind: 'model_api_key' };
        const fields = { api_key: String(data.api_key || '') };
        if (sel.startsWith('conn:')) target.connection_id = sel.slice(5);
        else if (sel.startsWith('preset:')) {
          target.provider = sel.slice(7);
          fields.name = String(data.name || '').trim();
          fields.base_url = String(data.base_url || '').trim();
          fields.model = String(data.model || '').trim();
        }
        delivery = await callApi('/api/secrets/deliver', 'POST', { target, fields });
        receiptText = `已保存模型 Key（${delivery.target_label || 'API'}）`;
      } else {
        delivery = await callApi('/api/secrets/deliver', 'POST', {
          target: { kind: 'file_env', workspace: collected.workspace, path: collected.path },
          entries: [{ name: collected.name, value: collected.value }],
        });
        receiptText = `已写入 ${collected.path}（${collected.name}）`;
      }
      deps.toast?.(delivery?.detail || '已保存');
      deps.onAfterChange?.(delivery);
      if (collected.notifyRoom && receiptText && deps.sendSafeRoomReceipt) {
        await deps.sendSafeRoomReceipt(receiptText);
      }
    } catch (error) {
      deps.toast?.(error.message || '提交失败，请重试', true);
    }
  }

  function bindEvents(root) {
    root.onclick = async event => {
      if (event.target === root) {
        wipeAndClose();
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
        if (action === 'close') wipeAndClose();
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
      if (tabBtn && state) {
        state.tab = tabBtn.dataset.secretTab;
        render();
        return;
      }
      const hubSubBtn = event.target.closest('[data-secret-hub-sub]');
      if (hubSubBtn && state) {
        state.hubSub = hubSubBtn.dataset.secretHubSub;
        render();
        return;
      }
      const delEnvBtn = event.target.closest('[data-secret-delete-env]');
      if (delEnvBtn && state) {
        const name = delEnvBtn.dataset.secretDeleteEnv;
        if (!confirm(`删除 ${name}？`)) return;
        try {
          await callApi(`/api/secrets/env/${encodeURIComponent(name)}`, 'DELETE');
          state.envKeys = (state.envKeys || []).filter(k => k.name !== name);
          deps.toast?.(`已删除 ${name}`);
          render();
        } catch (err) {
          showError(root, err.message);
        }
      }
    };

    const modelSelect = root.querySelector('#secret-model-target');
    if (modelSelect && state) {
      modelSelect.onchange = () => { state.modelTarget = modelSelect.value; render(); };
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
      form.onsubmit = event => {
        event.preventDefault();
        if (!state) return;
        const errEl = root.querySelector('#secret-modal-error');
        if (errEl) errEl.hidden = true;
        try {
          if (state.mode === 'prompt') {
            const collected = collectPromptSubmission(form);
            const callbacks = {
              onStart: state.onStart,
              onSubmitted: state.onSubmitted,
              onError: state.onError,
            };
            // Close & wipe inputs immediately on confirm; execute delivery asynchronously.
            wipeAndClose();
            void executePromptSubmission(collected, callbacks);
          } else {
            const collected = collectStandaloneSubmission(root, form);
            wipeAndClose();
            void executeStandaloneSubmission(collected);
          }
        } catch (error) {
          showError(root, error.message);
        }
      };
    }
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state) {
      event.preventDefault();
      wipeAndClose();
    }
  });

  function openForPrompt(message, { onStart, onSubmitted, onError } = {}) {
    if (!message?.prompt || message.prompt.kind !== 'secret') return;
    wipeAndClose();
    state = {
      mode: 'prompt',
      messageId: message.id,
      prompt: message.prompt,
      onStart,
      onSubmitted,
      onError,
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
    compactTargetHint,
  });
})();
