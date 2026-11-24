(() => {
  'use strict';

  const SUMMON_ROOM_ID = 'room-default-bot-maintenance';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PROVIDERS = [
    { id: 'codex', kind: 'codex', name: 'Codex 订阅', subtitle: 'ChatGPT 账号授权', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', defaultModel: 'gpt-6.1-terra' },
    { id: 'deepseek', kind: 'api', name: 'DeepSeek', subtitle: '只需 API Key', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    { id: 'openai', kind: 'api', name: 'OpenAI', subtitle: '只需 API Key', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.4' },
    { id: 'anthropic', kind: 'api', name: 'Anthropic', subtitle: 'Claude API Key', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5' },
    { id: 'openrouter', kind: 'api', name: 'OpenRouter', subtitle: '多模型聚合 Key', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-5.4' },
    { id: 'openai-compatible', kind: 'api', name: '自定义 API', subtitle: '兼容接口 / 本机', provider: 'openai-compatible', api: 'openai-completions', baseUrl: '', defaultModel: '' },
  ];

  const ob = {
    open: false,
    preview: false,
    focusActive: false,
    previewFocus: false,
    selectedProvider: 'deepseek',
    localSources: [],
    catalog: null,
    draft: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', model: 'deepseek-chat', apiKey: '', allowNoKey: false },
    busy: false,
    phase: 'idle', // 'idle' | 'saving' | 'testing' | 'oauth' | 'success' | 'error'
    statusText: '',
    oauthConnId: null,
    oauthState: null,
    oauthTimer: null,
    callbacks: null,
    introPlayed: false,
    dismissedInSession: false,
  };

  function providerDef(id) {
    return PROVIDERS.find(item => item.id === id) || PROVIDERS[1];
  }

  function isLocalMode() {
    const hubMode = window.SummonHub?.state?.mode;
    return !hubMode || hubMode === 'local';
  }

  function providerModels(providerId) {
    if (!ob.catalog) return [];
    if (providerId === 'codex') return ob.catalog.codexModels || [];
    const preset = (ob.catalog.presets || []).find(item => item.id === providerId);
    return preset?.models || [];
  }

  function selectProvider(id) {
    stopOAuthPoll();
    ob.selectedProvider = id;
    const def = providerDef(id);
    const models = providerModels(id);
    ob.draft = {
      name: def.name,
      baseUrl: def.baseUrl,
      api: def.api,
      model: models[0]?.id || def.defaultModel || '',
      apiKey: '',
      allowNoKey: false,
    };
    ob.phase = 'idle';
    ob.statusText = '';
    ob.oauthState = null;
    ob.oauthConnId = null;
    renderOverlayContent();
  }

  function stopOAuthPoll() {
    if (ob.oauthTimer) {
      clearTimeout(ob.oauthTimer);
      ob.oauthTimer = null;
    }
  }

  function avatarSvg(size = 76) {
    const avatars = window.SummonAvatars;
    if (avatars?.render) {
      const style = avatars.defaults('bot-default-eggbot-local');
      return avatars.render(style, size, {
        key: 'onboarding:hero',
        identity: 'onboarding:summon',
        preview: true,
        intro: true,
        followPointer: true,
        state: ob.phase === 'testing' || ob.phase === 'saving' ? 'work' : 'idle',
      });
    }
    return `<img src="/icons/icon-192.png" alt="Summon Bot" width="${size}" height="${size}" style="border-radius:20px">`;
  }

  function renderProviderIcon(item) {
    if (window.SummonModelIcons?.svg) {
      return window.SummonModelIcons.svg({ kind: item.kind, provider: item.provider, model: item.defaultModel }, 18);
    }
    return '';
  }

  async function loadCatalogAndLocal() {
    const api = ob.callbacks?.api;
    if (!api) return;
    const [catalog, local] = await Promise.all([
      api('/api/model-settings').catch(() => null),
      api('/api/model-settings/local').catch(() => ({ sources: [] })),
    ]);
    ob.catalog = catalog;
    ob.localSources = (local?.sources || []).filter(item => item.available);
    if (ob.localSources.some(s => s.kind === 'codex')) {
      ob.selectedProvider = 'codex';
    }
    const models = providerModels(ob.selectedProvider);
    if (!ob.draft.model && models[0]?.id) ob.draft.model = models[0].id;
  }

  function ensureOverlayElement() {
    let root = document.getElementById('summon-onboarding-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'summon-onboarding-root';
    root.className = 'ob-root';
    root.innerHTML = `
      <div class="ob-portal-backdrop" aria-hidden="true"></div>
      <div class="ob-portal-ring" aria-hidden="true"></div>
      <div class="ob-intro-center" id="ob-intro-center" aria-hidden="true">
        <div class="ob-intro-orb">
          <div class="ob-intro-orb-badge">${avatarSvg(68)}</div>
          <div class="ob-intro-orb-title">Summon Bot</div>
        </div>
      </div>
      <main class="ob-stage" id="ob-stage" role="dialog" aria-modal="true" aria-label="接入你的第一个 AI"></main>
    `;
    document.body.appendChild(root);
    return root;
  }

  function playArcDiaIntro(root) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const intro = root.querySelector('#ob-intro-center');
    const desktop = window.SummonDesktop;
    if (reduced) {
      root.classList.add('is-expanded', 'is-ready', 'is-settled');
      intro?.classList.add('is-settled');
      if (desktop?.isIntroWindow) void desktop.settleIntroWindow?.({ width: 620, height: 700 });
      return;
    }
    void root.offsetWidth;
    // Phase 1 (0 -> 600ms): Orb rises & breathes over the real desktop wallpaper.
    // Phase 2 (600ms -> 2050ms): Slow full-screen radial expansion wave across the whole monitor.
    setTimeout(() => {
      if (!document.body.contains(root)) return;
      root.classList.add('is-expanding', 'is-expanded');
    }, 520);
    // Phase 3 (2000ms): Intro emblem settles and floating Setup Window glides into center.
    setTimeout(() => {
      if (!document.body.contains(root)) return;
      intro?.classList.add('is-settled');
      root.classList.add('is-ready');
    }, 1850);
    // Phase 4 (2550ms): Full-screen backdrop recedes back to transparent desktop & window shrinks to non-fullscreen floating card!
    setTimeout(() => {
      if (!document.body.contains(root)) return;
      root.classList.add('is-settled');
      if (desktop?.isIntroWindow && desktop.settleIntroWindow) {
        setTimeout(() => {
          if (document.body.contains(root)) {
            void desktop.settleIntroWindow({ width: 620, height: 700 });
          }
        }, 560);
      }
    }, 2400);
  }

  function renderOverlayContent() {
    const root = document.getElementById('summon-onboarding-root');
    if (!root) return;
    const stage = root.querySelector('#ob-stage');
    if (!stage) return;

    const def = providerDef(ob.selectedProvider);
    const choices = providerModels(ob.selectedProvider);
    const activeExisting = ob.catalog?.connections?.find(c => c.id === ob.catalog.activeId && c.configured);
    const hasLocalCodex = ob.localSources.some(s => s.kind === 'codex');
    const faceClass = ob.phase === 'testing' || ob.phase === 'saving'
      ? 'is-testing'
      : ob.phase === 'success' ? 'is-success' : '';

    const inDesktopIntro = Boolean(window.SummonDesktop?.isIntroWindow);
    const closeBtnHtml = ob.preview
      ? '<button type="button" class="ob-ghost-pill" data-ob-action="close-preview">退出预览</button>'
      : inDesktopIntro
        ? '<button type="button" class="ob-ghost-pill" data-ob-action="close-intro" aria-label="关闭窗口">✕</button>'
        : '';

    const localBanner = ob.localSources.length
      ? `<div class="ob-local-list">${ob.localSources.map(src => `
          <div class="ob-local-card">
            <div class="ob-local-copy">
              <strong>检测到本机已有 ${esc(src.name)} 订阅</strong>
              <small>直接复用本机登录态，无需重新授权或设备码</small>
            </div>
            <button type="button" class="ob-primary-btn" data-ob-action="import-local" data-kind="${esc(src.kind)}" ${ob.busy ? 'disabled' : ''}>
              直接复用并检测
            </button>
          </div>`).join('')}</div><div class="ob-divider">或者选择其他接入方式</div>`
      : '';

    const previewActiveBanner = ob.preview && activeExisting
      ? `<div class="ob-preview-existing">
          <span>当前已接入 <strong>${esc(activeExisting.name)}</strong>（${esc(activeExisting.model)}）</span>
          <button type="button" class="ob-primary-btn" data-ob-action="test-existing" data-id="${esc(activeExisting.id)}" ${ob.busy ? 'disabled' : ''}>
            检测并继续演示
          </button>
        </div>`
      : '';

    const providerGrid = `<div class="ob-provider-grid" role="tablist" aria-label="选择 AI 服务商">${PROVIDERS.map(item => `
      <button type="button" role="tab" aria-selected="${item.id === ob.selectedProvider}" class="ob-provider-tile ${item.id === ob.selectedProvider ? 'is-selected' : ''}" data-ob-action="pick-provider" data-provider="${esc(item.id)}" ${ob.busy ? 'disabled' : ''}>
        <span class="ob-provider-head">${renderProviderIcon(item)}<strong>${esc(item.name)}</strong></span>
        <small>${esc(item.id === 'codex' && hasLocalCodex ? '已登录 · 直接复用' : item.subtitle)}</small>
      </button>`).join('')}</div>`;

    let formBody = '';
    if (def.kind === 'codex') {
      if (hasLocalCodex) {
        formBody = `<div class="ob-oauth-box">
          <small>已检测到这台电脑的本地 Codex 订阅登录，直接复用即可，无需任何设备码。</small>
          <div class="ob-oauth-actions">
            <button type="button" class="ob-primary-btn" data-ob-action="import-local" data-kind="codex" ${ob.busy ? 'disabled' : ''}>
              ${ob.phase === 'testing' ? '<span class="ob-spinner"></span>正在检测可用性…' : ob.phase === 'saving' ? '<span class="ob-spinner"></span>正在导入…' : '直接复用本机 Codex 并检测'}
            </button>
          </div>
        </div>`;
      } else {
        const waiting = ob.oauthState && ['starting', 'waiting'].includes(ob.oauthState.status);
        formBody = `<div class="ob-oauth-box">
          ${waiting ? `
            <small>${ob.oauthState.status === 'starting' ? '正在获取授权信息…' : '请在打开的浏览器页面中完成登录'}</small>
            ${ob.oauthState.userCode ? `<div class="ob-device-code">${esc(ob.oauthState.userCode)}</div>` : ''}
            <div class="ob-oauth-actions">
              ${ob.oauthState.verificationUri ? `<a class="ob-primary-btn" href="${esc(ob.oauthState.verificationUri)}" target="_blank" rel="noopener noreferrer">打开登录页面</a>` : ''}
              <button type="button" class="ob-secondary-btn" data-ob-action="cancel-oauth">取消</button>
            </div>
          ` : `
            <small>未检测到本机 Codex 登录，你可以登录 Codex 订阅账号，或在上方改用 DeepSeek / OpenAI / Anthropic 等 API Key。</small>
            <div class="ob-oauth-actions">
              <button type="button" class="ob-primary-btn" data-ob-action="start-codex-oauth" ${ob.busy ? 'disabled' : ''}>登录 Codex 订阅</button>
            </div>
          `}
        </div>`;
      }
    } else {
      const isCustom = def.id === 'openai-compatible';
      const datalistId = 'ob-model-choices';
      formBody = `<form class="ob-form" id="ob-model-form">
        ${isCustom ? `
          <label class="ob-field"><span>API 地址</span><input name="baseUrl" type="url" required value="${esc(ob.draft.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label>
          <label class="ob-field"><span>接口协议</span><select name="api">
            <option value="openai-completions" ${ob.draft.api === 'openai-completions' ? 'selected' : ''}>OpenAI Chat Completions</option>
            <option value="openai-responses" ${ob.draft.api === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
            <option value="anthropic-messages" ${ob.draft.api === 'anthropic-messages' ? 'selected' : ''}>Anthropic Messages</option>
          </select></label>
        ` : ''}
        <label class="ob-field">
          <span>API Key${isCustom ? '（如本机服务无需密钥可勾选下方选项）' : ''}</span>
          <input name="apiKey" type="password" ${!isCustom || !ob.draft.allowNoKey ? 'required' : ''} value="${esc(ob.draft.apiKey)}" placeholder="粘贴你的 ${esc(def.name)} API Key" autocomplete="new-password" spellcheck="false">
        </label>
        <label class="ob-field">
          <span>默认模型</span>
          <input name="model" list="${datalistId}" required value="${esc(ob.draft.model)}" placeholder="填写或选择模型 ID" autocomplete="off" spellcheck="false">
          <datalist id="${datalistId}">${choices.map(m => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}</datalist>
        </label>
        ${isCustom ? `<label class="ob-checkbox"><input type="checkbox" name="allowNoKey" ${ob.draft.allowNoKey ? 'checked' : ''}>此服务无需 API Key（例如本机 Ollama / LM Studio）</label>` : `
          <details class="ob-advanced">
            <summary>自定义代理地址或协议</summary>
            <div class="ob-advanced-body">
              <label class="ob-field"><span>API 地址</span><input name="baseUrl" type="url" value="${esc(ob.draft.baseUrl)}" placeholder="${esc(def.baseUrl)}"></label>
              <label class="ob-field"><span>接口协议</span><select name="api">
                <option value="openai-completions" ${ob.draft.api === 'openai-completions' ? 'selected' : ''}>OpenAI Chat Completions</option>
                <option value="openai-responses" ${ob.draft.api === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
                <option value="anthropic-messages" ${ob.draft.api === 'anthropic-messages' ? 'selected' : ''}>Anthropic Messages</option>
              </select></label>
            </div>
          </details>
        `}
        <div class="ob-actions">
          <span style="font-size:12.5px;color:var(--muted)">密钥仅保存在你这台电脑本地</span>
          <button type="submit" class="ob-primary-btn" ${ob.busy ? 'disabled' : ''}>
            ${ob.phase === 'testing' ? '<span class="ob-spinner"></span>正在检测可用性…' : ob.phase === 'saving' ? '<span class="ob-spinner"></span>正在保存…' : '接通并检测'}
          </button>
        </div>
      </form>`;
    }

    const statusBar = ob.statusText
      ? `<div class="ob-status ${ob.phase === 'success' ? 'is-ok' : ob.phase === 'error' ? 'is-error' : 'is-info'}" role="status">
          ${ob.phase === 'testing' || ob.phase === 'saving' || ob.phase === 'oauth' ? '<span class="ob-spinner"></span>' : ''}
          <span>${esc(ob.statusText)}</span>
        </div>`
      : '';

    stage.innerHTML = `
      <div class="ob-window-bar">
        <span class="ob-window-brand">Summon Bot · 初始化</span>
        <div class="ob-window-controls">${closeBtnHtml}</div>
      </div>
      <header class="ob-hero">
        <div class="ob-hero-face ${faceClass}">${avatarSvg(64)}</div>
        <h1>接入你的第一个 AI</h1>
        <p>只需完成这一步——验证可用后进入 Summon 群，其余环境配置全由 AI 自动带你搞定。</p>
      </header>
      <section class="ob-card">
        ${previewActiveBanner}
        ${localBanner}
        ${providerGrid}
        ${formBody}
        ${statusBar}
      </section>
    `;
  }

  async function verifyAndEnterSummonChat(connId, label) {
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'testing';
    ob.statusText = `正在测试「${label || '模型'}」是否可用…`;
    renderOverlayContent();
    try {
      const test = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/test`, 'POST', {});
      await api('/api/model-settings/active', 'POST', { id: connId });
      ob.phase = 'success';
      ob.statusText = `连接成功 · ${test.model} 响应正常（${test.latencyMs}ms），正在进入 Summon 群…`;
      renderOverlayContent();
      if (ob.preview) {
        await new Promise(resolve => setTimeout(resolve, 680));
        await finishOverlayIntoChat({ preview: true });
      } else {
        await api('/api/onboarding/start', 'POST', {});
        await new Promise(resolve => setTimeout(resolve, 680));
        await finishOverlayIntoChat({ preview: false });
      }
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '模型连通性检测未通过，请检查配置后重试。';
      renderOverlayContent();
    }
  }

  async function finishOverlayIntoChat({ preview = false } = {}) {
    stopOAuthPoll();
    const root = document.getElementById('summon-onboarding-root');
    const desktop = window.SummonDesktop;
    if (desktop?.isIntroWindow && desktop.prepareIntroHandoff && desktop.finishIntroHandoff) {
      await desktop.prepareIntroHandoff({ preview }).catch(() => null);
      if (root) {
        root.classList.add('is-exiting');
        await new Promise(resolve => setTimeout(resolve, 260));
      }
      await desktop.finishIntroHandoff().catch(() => {});
      return;
    }
    if (root) {
      root.classList.add('is-exiting');
      await new Promise(resolve => setTimeout(resolve, 460));
      root.remove();
    }
    ob.open = false;
    ob.busy = false;
    ob.phase = 'idle';
    ob.statusText = '';
    if (preview) {
      ob.previewFocus = true;
      setFocusMode(true);
    } else {
      setFocusMode(true);
    }
    await ob.callbacks?.onEnterOnboardingChat?.(SUMMON_ROOM_ID, { preview });
  }

  async function handleImportLocal(kind) {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'saving';
    ob.statusText = `正在导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 订阅…`;
    renderOverlayContent();
    try {
      const res = await api('/api/model-settings/local/import', 'POST', { kind, activate: true });
      const connId = res.importedId || `${kind}-local`;
      await verifyAndEnterSummonChat(connId, `本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 订阅`);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '导入本机登录失败';
      renderOverlayContent();
    }
  }

  async function handleStartCodexOAuth() {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'oauth';
    ob.statusText = '正在创建 Codex 订阅连接并获取设备授权码…';
    renderOverlayContent();
    try {
      const saved = await api('/api/model-settings/connections', 'POST', {
        kind: 'codex',
        name: 'Codex 订阅',
        model: ob.draft.model || 'gpt-6.1-terra',
      });
      const connId = saved.savedId || saved.connections?.find(c => c.kind === 'codex' && c.authMode !== 'codex-local')?.id;
      if (!connId) throw new Error('未能创建 Codex 订阅连接');
      ob.oauthConnId = connId;
      ob.oauthState = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/login`, 'POST', {});
      ob.busy = false;
      ob.statusText = '请在浏览器中完成授权，授权完成后将自动检测并进入主界面…';
      renderOverlayContent();
      void pollCodexOAuth(connId);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '无法发起 Codex 授权';
      renderOverlayContent();
    }
  }

  async function pollCodexOAuth(connId) {
    stopOAuthPoll();
    const api = ob.callbacks?.api;
    if (!api || !ob.open || ob.oauthConnId !== connId) return;
    try {
      const status = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/login`);
      ob.oauthState = status;
      if (['starting', 'waiting'].includes(status.status)) {
        renderOverlayContent();
        ob.oauthTimer = setTimeout(() => void pollCodexOAuth(connId), 2000);
        return;
      }
      if (status.status === 'completed') {
        await verifyAndEnterSummonChat(connId, 'Codex 订阅');
        return;
      }
      if (status.status === 'failed') {
        ob.phase = 'error';
        ob.statusText = status.error || 'Codex 授权未完成，请重试。';
      } else {
        ob.phase = 'idle';
        ob.statusText = '';
      }
      renderOverlayContent();
    } catch (error) {
      ob.phase = 'error';
      ob.statusText = error.message || '读取授权状态失败';
      renderOverlayContent();
    }
  }

  async function handleCancelOAuth() {
    stopOAuthPoll();
    const api = ob.callbacks?.api;
    if (api && ob.oauthConnId) {
      await api(`/api/model-settings/connections/${encodeURIComponent(ob.oauthConnId)}/login`, 'DELETE', {}).catch(() => {});
    }
    ob.oauthConnId = null;
    ob.oauthState = null;
    ob.phase = 'idle';
    ob.statusText = '';
    renderOverlayContent();
  }

  async function handleFormSubmit(form) {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    const def = providerDef(ob.selectedProvider);
    const fd = new FormData(form);
    const baseUrl = String(fd.get('baseUrl') || ob.draft.baseUrl || def.baseUrl || '').trim();
    const apiProto = String(fd.get('api') || ob.draft.api || def.api || 'openai-completions').trim();
    const model = String(fd.get('model') || '').trim();
    const apiKey = String(fd.get('apiKey') || '').trim();
    const allowNoKey = form.elements.allowNoKey?.checked === true;
    ob.draft = { ...ob.draft, baseUrl, api: apiProto, model, apiKey, allowNoKey };

    ob.busy = true;
    ob.phase = 'saving';
    ob.statusText = '正在保存模型配置…';
    renderOverlayContent();
    try {
      const saved = await api('/api/model-settings/connections', 'POST', {
        kind: 'api',
        name: def.id === 'openai-compatible' ? (model || '自定义 API') : def.name,
        provider: def.provider,
        api: apiProto,
        baseUrl,
        model,
        apiKey,
        allowNoKey,
        activate: true,
      });
      const connId = saved.savedId || saved.activeId || saved.connections?.at(-1)?.id;
      if (!connId) throw new Error('未能保存模型配置');
      await verifyAndEnterSummonChat(connId, def.name);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '模型配置保存失败';
      renderOverlayContent();
    }
  }

  function setFocusMode(enabled, { celebrate = false } = {}) {
    const wasFocused = ob.focusActive;
    ob.focusActive = Boolean(enabled);
    document.body.classList.toggle('onboarding-focus', ob.focusActive);
    if (wasFocused && !ob.focusActive) {
      document.body.classList.add('onboarding-unlocking');
      setTimeout(() => document.body.classList.remove('onboarding-unlocking'), 720);
      if (celebrate) ob.callbacks?.toast?.('初始化完成，欢迎进入 Summon Bot 工作台');
    }
  }

  async function openOverlay({ preview = false, skipBloom = false } = {}) {
    if (ob.open) return;
    ob.open = true;
    ob.preview = preview;
    ob.busy = false;
    ob.phase = 'idle';
    ob.statusText = '';
    const root = ensureOverlayElement();
    renderOverlayContent();
    if (skipBloom) {
      const intro = root.querySelector('#ob-intro-center');
      intro?.classList.add('is-settled');
      root.classList.add('is-expanded', 'is-settled');
      requestAnimationFrame(() => root.classList.add('is-ready'));
    } else {
      playArcDiaIntro(root);
    }
    await loadCatalogAndLocal();
    if (ob.open) renderOverlayContent();
  }

  function closePreview() {
    stopOAuthPoll();
    if (window.SummonDesktop?.isIntroWindow && window.SummonDesktop.closeIntroWindow) {
      void window.SummonDesktop.closeIntroWindow();
      return;
    }
    const root = document.getElementById('summon-onboarding-root');
    root?.remove();
    ob.open = false;
    ob.preview = false;
    ob.previewFocus = false;
    ob.busy = false;
    setFocusMode(false);
    ob.callbacks?.onRender?.();
  }

  function enterFocusFromDesktop({ preview = false } = {}) {
    if (preview) ob.previewFocus = true;
    setFocusMode(true);
    void ob.callbacks?.onEnterOnboardingChat?.(SUMMON_ROOM_ID, { preview });
  }

  async function exitFocusMode({ previewOnly = false } = {}) {
    if (ob.previewFocus || previewOnly) {
      ob.previewFocus = false;
      ob.preview = false;
      setFocusMode(false, { celebrate: true });
      ob.callbacks?.onRender?.();
      return;
    }
    try {
      await ob.callbacks?.api?.('/api/onboarding/complete', 'POST', { summary: '用户跳过剩余初始化进入完整工作台' });
    } catch {}
    setFocusMode(false, { celebrate: true });
    await ob.callbacks?.refresh?.(true);
  }

  function syncState(onboarding) {
    if (!isLocalMode()) {
      if (ob.open && !ob.preview) {
        document.getElementById('summon-onboarding-root')?.remove();
        ob.open = false;
      }
      if (ob.focusActive && !ob.previewFocus) setFocusMode(false);
      return;
    }
    if (ob.preview || ob.previewFocus) return;
    if (!onboarding) return;
    if (onboarding.status === 'awaiting_model' && !onboarding.hasActiveModel) {
      setFocusMode(false);
      if (!ob.open) void openOverlay({ preview: false });
      return;
    }
    if (onboarding.status === 'configuring_chat') {
      if (ob.open) {
        document.getElementById('summon-onboarding-root')?.remove();
        ob.open = false;
      }
      if (!ob.focusActive) {
        setFocusMode(true);
        void ob.callbacks?.onEnterOnboardingChat?.(onboarding.roomId || SUMMON_ROOM_ID, { preview: false });
      }
      return;
    }
    if (onboarding.status === 'completed') {
      if (ob.open) {
        document.getElementById('summon-onboarding-root')?.remove();
        ob.open = false;
      }
      if (ob.focusActive) {
        setFocusMode(false, { celebrate: true });
      }
    }
  }

  function isFocusLocked() {
    return Boolean(ob.focusActive || ob.previewFocus);
  }

  function renderFocusHeaderActions() {
    if (!isFocusLocked()) return '';
    return `<span class="ob-focus-pill"><i class="ob-focus-dot" aria-hidden="true"></i>初始化引导中</span>
      <button type="button" class="secondary-button small-button" data-ob-action="skip-focus">${ob.previewFocus ? '结束预览' : '跳过引导，进入工作台'}</button>`;
  }

  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-ob-action]');
    if (!btn) return;
    const action = btn.dataset.obAction;
    if (action === 'pick-provider') return selectProvider(btn.dataset.provider);
    if (action === 'import-local') return void handleImportLocal(btn.dataset.kind);
    if (action === 'start-codex-oauth') return void handleStartCodexOAuth();
    if (action === 'cancel-oauth') return void handleCancelOAuth();
    if (action === 'close-preview' || action === 'close-intro') return closePreview();
    if (action === 'test-existing') return void verifyAndEnterSummonChat(btn.dataset.id, '当前默认模型');
    if (action === 'skip-focus') return void exitFocusMode({ previewOnly: ob.previewFocus });
  });

  document.addEventListener('input', event => {
    const form = event.target.closest('#ob-model-form');
    if (!form || !event.target.name) return;
    ob.draft[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (event.target.name === 'allowNoKey') renderOverlayContent();
  });

  document.addEventListener('submit', event => {
    if (event.target.id === 'ob-model-form') {
      event.preventDefault();
      void handleFormSubmit(event.target);
    }
  });

  window.SummonOnboarding = Object.freeze({
    bind(callbacks) { ob.callbacks = callbacks; },
    syncState,
    isFocusLocked,
    renderFocusHeaderActions,
    startDesktopIntro({ preview = false, skipBloom = false } = {}) { void openOverlay({ preview, skipBloom }); },
    startPreview() { void openOverlay({ preview: true, skipBloom: false }); },
    enterFocusFromDesktop,
    exitFocusMode,
    SUMMON_ROOM_ID,
  });
})();
