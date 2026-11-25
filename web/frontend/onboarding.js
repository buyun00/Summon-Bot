(() => {
  'use strict';

  const SUMMON_ROOM_ID = 'room-default-bot-maintenance';
  const LIVE_STATUSES = new Set(['opening', 'running', 'submitted', 'waiting', 'queued', 'needs_input', 'awaiting_input']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PROVIDERS = [
    { id: 'codex', kind: 'codex', name: 'Codex 订阅', subtitle: 'ChatGPT 账号授权', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', defaultModel: 'gpt-6.1-terra' },
    { id: 'grok', kind: 'grok', name: 'Grok 订阅', subtitle: 'Grok 账号授权', provider: 'xai', api: 'openai-responses', baseUrl: 'https://cli-chat-proxy.grok.com/v1', defaultModel: 'grok-4.7' },
    { id: 'deepseek', kind: 'api', name: 'DeepSeek', subtitle: '只需 API Key', provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    { id: 'openai', kind: 'api', name: 'OpenAI', subtitle: '只需 API Key', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.4' },
    { id: 'anthropic', kind: 'api', name: 'Anthropic', subtitle: 'Claude API Key', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5' },
    { id: 'openrouter', kind: 'api', name: 'OpenRouter', subtitle: '多模型聚合 Key', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-5.4' },
    { id: 'openai-compatible', kind: 'api', name: '自定义 API', subtitle: 'Token Plan / 本机', provider: 'openai-compatible', api: 'openai-completions', baseUrl: '', defaultModel: '' },
  ];

  const ob = {
    open: false,
    preview: false,
    stage: 'model', // 'model' | 'bot'
    morphing: false,
    selectedProvider: 'deepseek',
    localSources: [],
    catalog: null,
    draft: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', model: 'deepseek-chat', apiKey: '', allowNoKey: false },
    busy: false,
    phase: 'idle',
    statusText: '',
    oauthConnId: null,
    oauthState: null,
    oauthTimer: null,
    // Stage 2: single-step Bot onboarding state
    botId: null,
    botName: '',
    bundledId: null,
    roomId: SUMMON_ROOM_ID,
    wakeMessageId: null,
    botStartedAt: 0,
    botMessages: [],
    botActivities: [],
    botExecutions: [],
    botSending: false,
    botPollTimer: null,
    botTickTimer: null,
    botRefreshPending: false,
    callbacks: null,
  };

  if (navigator.platform?.toLowerCase().includes('win')) {
    document.documentElement.classList.add('is-win');
  }

  function providerDef(id) {
    return PROVIDERS.find(item => item.id === id) || PROVIDERS[2];
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

  function formatElapsed(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function renderSimpleMarkdown(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const blocks = [];
    const withPlaceholders = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
      const idx = blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`) - 1;
      return `\u0000BLOCK_${idx}\u0000`;
    });
    let html = esc(withPlaceholders)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    html = html.replace(/\u0000BLOCK_(\d+)\u0000/g, (_m, i) => blocks[Number(i)] || '');
    return html;
  }

  function stopOAuthPoll() {
    if (ob.oauthTimer) { clearTimeout(ob.oauthTimer); ob.oauthTimer = null; }
  }

  function stopBotWatchers() {
    if (ob.botPollTimer) { clearInterval(ob.botPollTimer); ob.botPollTimer = null; }
    if (ob.botTickTimer) { clearInterval(ob.botTickTimer); ob.botTickTimer = null; }
  }

  function avatarSvg(id = 'bot-default-eggbot-local', size = 60, state = 'idle') {
    const avatars = window.SummonAvatars;
    if (avatars?.render) {
      const style = avatars.defaults(id);
      return avatars.render(style, size, { key: `onboarding:${id}`, identity: id, preview: true, state });
    }
    return `<img src="/icons/icon-192.png" alt="Summon Bot" width="${size}" height="${size}" style="border-radius:16px">`;
  }

  function renderProviderIcon(item) {
    return window.SummonModelIcons?.svg
      ? window.SummonModelIcons.svg({ kind: item.kind, provider: item.provider, model: item.defaultModel }, 17)
      : '';
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
    render();
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
    if (ob.localSources.some(s => s.kind === 'codex')) ob.selectedProvider = 'codex';
    else if (ob.localSources.some(s => s.kind === 'grok')) ob.selectedProvider = 'grok';
    const models = providerModels(ob.selectedProvider);
    if (!ob.draft.model && models[0]?.id) ob.draft.model = models[0].id;
  }

  function ensureOverlayElement() {
    let root = document.getElementById('summon-onboarding-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'summon-onboarding-root';
    root.className = 'ob-root';
    root.innerHTML = `<main class="ob-stage" id="ob-stage" role="dialog" aria-modal="true" aria-label="Summon Bot 初始化"></main>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('is-ready'));
    return root;
  }

  function renderModelStage() {
    const def = providerDef(ob.selectedProvider);
    const choices = providerModels(ob.selectedProvider);
    const activeExisting = ob.catalog?.connections?.find(c => c.id === ob.catalog.activeId && c.configured);
    const hasLocalCodex = ob.localSources.some(s => s.kind === 'codex');
    const hasLocalGrok = ob.localSources.some(s => s.kind === 'grok');
    const faceState = ob.phase === 'testing' || ob.phase === 'saving' ? 'work' : 'idle';
    const faceClass = ob.phase === 'testing' || ob.phase === 'saving' ? 'is-testing' : ob.phase === 'success' ? 'is-success' : '';

    const localBanner = ob.localSources.length
      ? `<div class="ob-local-list">${ob.localSources.map(src => `
          <div class="ob-local-card">
            <div class="ob-local-copy">
              <strong>检测到本机已有 ${esc(src.name)} 订阅</strong>
              <small>直接复用本机登录态，并自动衔接对接专职 Bot</small>
            </div>
            <button type="button" class="ob-primary-btn" data-ob-action="import-local" data-kind="${esc(src.kind)}" ${ob.busy ? 'disabled' : ''}>
              ${ob.busy && ob.phase !== 'idle' ? '<span class="ob-spinner"></span>检测中…' : '复用并继续'}
            </button>
          </div>`).join('')}</div><div class="ob-divider">或者选择其他接入方式</div>`
      : '';

    const previewActiveBanner = ob.preview && activeExisting
      ? `<div class="ob-preview-existing">
          <span>当前已接入 <strong>${esc(activeExisting.name)}</strong>（${esc(activeExisting.model)}）</span>
          <button type="button" class="ob-primary-btn" data-ob-action="preview-next" ${ob.busy ? 'disabled' : ''}>预览下一步 →</button>
        </div>`
      : '';

    const providerGrid = `<div class="ob-provider-grid" role="tablist" aria-label="选择 AI 服务商">${PROVIDERS.map(item => `
      <button type="button" role="tab" aria-selected="${item.id === ob.selectedProvider}" class="ob-provider-tile ${item.id === ob.selectedProvider ? 'is-selected' : ''}" data-ob-action="pick-provider" data-provider="${esc(item.id)}" ${ob.busy ? 'disabled' : ''}>
        <span class="ob-provider-head">${renderProviderIcon(item)}<strong>${esc(item.name)}</strong></span>
        <small>${esc((item.id === 'codex' && hasLocalCodex) || (item.id === 'grok' && hasLocalGrok) ? '已登录 · 直接复用' : item.subtitle)}</small>
      </button>`).join('')}</div>`;

    let formBody = '';
    if (def.kind === 'codex' || def.kind === 'grok') {
      const hasLocal = def.kind === 'codex' ? hasLocalCodex : hasLocalGrok;
      const subLabel = def.kind === 'codex' ? 'Codex' : 'Grok';
      if (!hasLocal) {
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
            <small>未检测到本机 ${subLabel} 登录，你可以登录 ${subLabel} 订阅账号，或在上方改用 DeepSeek / OpenAI / Anthropic / 自定义 API Key。</small>
            <div class="ob-oauth-actions">
              <button type="button" class="ob-primary-btn" data-ob-action="start-sub-oauth" data-kind="${esc(def.kind)}" ${ob.busy ? 'disabled' : ''}>登录 ${subLabel} 订阅</button>
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
          <span>API Key${isCustom ? '（本机服务无需密钥可勾选下方）' : ''}</span>
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
          <span style="font-size:12px;color:var(--muted)">密钥仅保存在你这台电脑本地</span>
          <button type="submit" class="ob-primary-btn" ${ob.busy ? 'disabled' : ''}>
            ${ob.phase === 'testing' ? '<span class="ob-spinner"></span>正在检测…' : ob.phase === 'saving' ? '<span class="ob-spinner"></span>正在保存…' : '接通并进入'}
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

    return `
      <div class="ob-window-bar">
        <span class="ob-window-brand">Summon Bot <span class="ob-step-dots"><span class="ob-step-dot is-active"></span><span class="ob-step-dot"></span></span></span>
        <div class="ob-window-controls">${ob.preview ? '<button type="button" class="ob-ghost-pill" data-ob-action="close-preview">退出预览</button>' : ''}</div>
      </div>
      <div class="ob-model-scroll">
        <header class="ob-hero">
          <div class="ob-hero-face ${faceClass}">${avatarSvg('bot-default-eggbot-local', 60, faceState)}</div>
          <h1>点亮你的第一个 AI</h1>
          <p>选择本机订阅或任意模型 API，接通后即可直接建群开工。</p>
        </header>
        ${previewActiveBanner}
        ${localBanner}
        ${providerGrid}
        ${formBody}
        ${statusBar}
      </div>
    `;
  }

  function botStageSnapshot() {
    const botId = ob.botId;
    const wakeIdx = ob.wakeMessageId ? ob.botMessages.findIndex(m => m.id === ob.wakeMessageId) : -1;
    const relevant = (wakeIdx >= 0 ? ob.botMessages.slice(wakeIdx + 1) : ob.botMessages)
      .filter(m => {
        if (m.id === ob.wakeMessageId) return false;
        const sender = m.senderId || m.author?.id;
        return !botId || sender === botId || sender === 'user';
      });
    const activeActivity = (ob.botActivities || []).find(a => !botId || a.bot_id === botId);
    const liveExec = (ob.botExecutions || []).find(e => LIVE_STATUSES.has(e.status) && (!botId || (e.execution_actor?.id || e.bot_id) === botId));
    const pendingExec = liveExec && ['needs_input', 'awaiting_input'].includes(liveExec.status) ? liveExec : null;
    const pendingPromptMsg = [...relevant].reverse().find(m => m.prompt && !m.prompt_response);
    const hasBotReply = relevant.some(m => (m.senderId || m.author?.id) === botId && (m.content || '').trim());
    const isWorking = Boolean(activeActivity || (liveExec && !pendingExec));
    const isReady = hasBotReply && !isWorking && !pendingExec && !pendingPromptMsg;
    const progressText = pendingExec
      ? (pendingExec.pending_requests?.[0]?.question || '等待你的确认或输入')
      : (activeActivity?.text || liveExec?.live_progress || liveExec?.work_summary || '正在检查本机 CLI、登录态与桥接脚本…');
    return { relevant, activeActivity, liveExec, pendingExec, pendingPromptMsg, hasBotReply, isWorking, isReady, progressText };
  }

  function renderBotStage() {
    const snap = botStageSnapshot();
    const label = ob.botName || (ob.bundledId === 'grok-build' ? 'Grok Build' : 'Codex');
    const avatarId = ob.botId || 'bot-default-eggbot-local';
    const elapsed = formatElapsed(Date.now() - (ob.botStartedAt || Date.now()));
    const badgeClass = snap.isReady ? 'is-done' : 'is-live';
    const badgeText = snap.isReady
      ? '已就绪 ✓'
      : snap.pendingExec || snap.pendingPromptMsg
        ? '需要你确认'
        : `对接中 ${elapsed}`;

    const feedItems = [];
    if (!snap.relevant.length) {
      feedItems.push(`<div class="ob-bot-empty">
        <span class="ob-spinner" style="width:20px;height:20px;color:var(--accent,#7d824b)"></span>
        <div>正在自动验证本机 <strong>${esc(label)}</strong> CLI、登录态与桥接脚本，完成后会在这里直接回报。</div>
      </div>`);
    } else {
      for (const msg of snap.relevant) {
        const isUser = (msg.senderId || msg.author?.id) === 'user';
        const bodyHtml = renderSimpleMarkdown(msg.content);
        if (bodyHtml) {
          feedItems.push(`<div class="ob-bubble ${isUser ? 'is-user' : 'is-bot'}">${bodyHtml}</div>`);
        }
        if (msg.prompt && !msg.prompt_response) {
          const p = msg.prompt;
          if (p.kind === 'secret') {
            feedItems.push(`<div class="ob-prompt-card">
              <strong>${esc(p.title || '需要安全录入凭据')}</strong>
              ${p.description ? `<div style="font-size:12.5px;color:var(--muted)">${esc(p.description)}</div>` : ''}
              <div><button type="button" class="ob-primary-btn" data-ob-action="open-secret-prompt" data-msg-id="${esc(msg.id)}">${esc(p.submit_label || '打开隐私输入窗')}</button></div>
            </div>`);
          } else {
            const q = p.questions?.[0];
            const opts = q?.options || [];
            feedItems.push(`<div class="ob-prompt-card">
              <strong>${esc(p.title || q?.label || '请确认')}</strong>
              ${opts.length ? `<div class="ob-prompt-choices">${opts.map(opt => `
                <button type="button" class="ob-secondary-btn" data-ob-action="reply-prompt-opt" data-msg-id="${esc(msg.id)}" data-label="${esc(opt.label)}">${esc(opt.label)}</button>`).join('')}</div>` : ''}
            </div>`);
          }
        }
      }
    }

    if (snap.pendingExec?.pending_requests?.length) {
      const req = snap.pendingExec.pending_requests[0];
      const execRef = snap.pendingExec.execution_ref;
      feedItems.push(`<div class="ob-prompt-card">
        <strong>${esc(req.kind === 'approval' ? '执行权限确认' : '执行会话等待输入')}</strong>
        ${req.question ? `<div style="font-size:13px">${esc(req.question)}</div>` : ''}
        ${req.choices?.length ? `<div class="ob-prompt-choices">${req.choices.map(c => `
          <button type="button" class="ob-secondary-btn" data-ob-action="reply-exec-req" data-exec-id="${esc(execRef?.id || snap.pendingExec.id)}" data-req-id="${esc(req.request_id || '')}" data-val="${esc(c.id)}">${esc(c.label || c.id)}</button>`).join('')}</div>` : ''}
      </div>`);
    }

    return `
      <div class="ob-window-bar">
        <span class="ob-window-brand">Summon Bot · 接入 ${esc(label)} <span class="ob-step-dots"><span class="ob-step-dot is-done"></span><span class="ob-step-dot is-active"></span></span></span>
        <div class="ob-window-controls">
          ${ob.preview
            ? '<button type="button" class="ob-ghost-pill" data-ob-action="close-preview">退出预览</button>'
            : '<button type="button" class="ob-ghost-pill" data-ob-action="finish-to-main">跳过，直接建群 →</button>'}
        </div>
      </div>
      <div class="ob-bot-shell">
        <div class="ob-bot-header">
          <div class="ob-bot-identity">
            ${avatarSvg(avatarId, 44, snap.isWorking ? 'work' : 'idle')}
            <div class="ob-bot-titles">
              <h2>${snap.isReady ? `${esc(label)} 已就绪` : `正在对接 ${esc(label)}`}</h2>
              <p>${snap.isReady ? '本机自检与桥接已完成，可以直接建群开始工作' : '单步自检本机环境与桥接脚本，无需进入单独聊天室'}</p>
            </div>
          </div>
          <span class="ob-bot-badge ${badgeClass}">
            ${snap.isReady ? '' : '<span class="ob-live-dot"></span>'}
            <span data-ob-badge-text>${esc(badgeText)}</span>
          </span>
        </div>
        ${!snap.isReady ? `
          <div class="ob-bot-progress">
            <span class="ob-bot-progress-left">
              <span class="ob-spinner" style="color:var(--accent,#7d824b)"></span>
              <span class="ob-bot-progress-text">${esc(snap.progressText)}</span>
            </span>
            <span class="ob-bot-timer" data-ob-timer>${esc(elapsed)}</span>
          </div>` : ''}
        <div class="ob-bot-feed" id="ob-bot-feed">${feedItems.join('')}</div>
        ${snap.isReady ? `
          <div class="ob-ready-bar">
            <span>✓ ${esc(label)} 对接完成，现在可以创建你的第一个群聊</span>
            <button type="button" class="ob-primary-btn" data-ob-action="finish-to-main">进入工作台，新建群聊 →</button>
          </div>` : ''}
        <form class="ob-bot-composer" id="ob-bot-reply-form">
          <input name="text" type="text" placeholder="${snap.isReady ? '还需要让它顺手检查点什么？或直接点上方进入…' : `给 ${esc(label)} 补充说明或回答…`}" autocomplete="off" ${ob.botSending ? 'disabled' : ''}>
          <button type="submit" class="ob-primary-btn" ${ob.botSending ? 'disabled' : ''}>发送</button>
        </form>
      </div>
    `;
  }

  function render() {
    const root = document.getElementById('summon-onboarding-root');
    if (!root) return;
    const stage = root.querySelector('#ob-stage');
    if (!stage) return;
    root.classList.toggle('is-stage-bot', ob.stage === 'bot');
    const prevInput = document.activeElement?.closest('#ob-bot-reply-form')?.querySelector('input[name=text]');
    const savedReplyText = prevInput ? prevInput.value : '';
    const hadReplyFocus = Boolean(prevInput);
    stage.innerHTML = ob.stage === 'bot' ? renderBotStage() : renderModelStage();
    if (ob.stage === 'bot') {
      const feed = stage.querySelector('#ob-bot-feed');
      if (feed) feed.scrollTop = feed.scrollHeight;
      if (hadReplyFocus) {
        const nextInput = stage.querySelector('#ob-bot-reply-form input[name=text]');
        if (nextInput) { nextInput.value = savedReplyText; nextInput.focus(); }
      }
    }
  }

  async function pollBotStage() {
    if (!ob.open || ob.stage !== 'bot' || ob.preview || ob.botRefreshPending) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.botRefreshPending = true;
    try {
      const [roomRes, execRes] = await Promise.all([
        api(`/api/rooms/${encodeURIComponent(ob.roomId)}/messages`).catch(() => null),
        api(`/api/executions?room=${encodeURIComponent(ob.roomId)}`).catch(() => null),
      ]);
      if (!ob.open || ob.stage !== 'bot') return;
      if (roomRes) {
        ob.botMessages = roomRes.messages || [];
        ob.botActivities = roomRes.activities || [];
      }
      if (execRes) {
        ob.botExecutions = execRes.items || [];
      }
      render();
    } finally {
      ob.botRefreshPending = false;
    }
  }

  function startBotWatchers() {
    stopBotWatchers();
    void pollBotStage();
    ob.botPollTimer = setInterval(() => void pollBotStage(), 1800);
    ob.botTickTimer = setInterval(() => {
      if (!ob.open || ob.stage !== 'bot') return;
      const elapsed = formatElapsed(Date.now() - (ob.botStartedAt || Date.now()));
      const timerEl = document.querySelector('[data-ob-timer]');
      if (timerEl) timerEl.textContent = elapsed;
      const snap = botStageSnapshot();
      const badgeEl = document.querySelector('[data-ob-badge-text]');
      if (badgeEl && !snap.isReady && !snap.pendingExec && !snap.pendingPromptMsg) {
        badgeEl.textContent = `对接中 ${elapsed}`;
      }
    }, 1000);
  }

  async function morphToBotStage({ botId, botName, bundledId, roomId, wakeMessageId, preview = false }) {
    ob.stage = 'bot';
    ob.busy = false;
    ob.phase = 'idle';
    ob.statusText = '';
    ob.botId = botId || null;
    ob.botName = botName || (bundledId === 'grok-build' ? 'Grok Build' : 'Codex');
    ob.bundledId = bundledId || 'codex';
    ob.roomId = roomId || SUMMON_ROOM_ID;
    ob.wakeMessageId = wakeMessageId || null;
    ob.botStartedAt = Date.now();
    ob.botMessages = preview
      ? [{ id: 'preview-reply', senderId: ob.botId || 'preview-codex', content: '**自检完成**\n- Codex CLI 已就绪\n- 本机登录态与 `scripts/app-server.mjs` 桥接验证通过\n\n随时可以建群开始干活。' }]
      : [];
    ob.botActivities = [];
    ob.botExecutions = [];
    render();
    void window.SummonDesktop?.morphWindow?.('bot', { duration: 400 });
    if (!preview) startBotWatchers();
  }

  async function transitionToMainNewGroup({ preview = false } = {}) {
    if (ob.morphing) return;
    ob.morphing = true;
    stopOAuthPoll();
    stopBotWatchers();
    const api = ob.callbacks?.api;
    if (!preview && api) {
      await api('/api/onboarding/finish', 'POST', {}).catch(() => {});
    }
    // Prepare the New Group Draft screen underneath BEFORE fading out overlay so reveal is instant & 0-flash!
    await ob.callbacks?.onEnterNewGroup?.({ preview });
    document.documentElement.classList.remove('desktop-onboarding-window');
    document.body.classList.add('ob-revealing-main');
    if (location.search.includes('onboarding_window')) {
      try { history.replaceState(null, '', '/'); } catch {}
    }

    const root = document.getElementById('summon-onboarding-root');
    const morphPromise = window.SummonDesktop?.morphWindow?.('main', { duration: 440 }) || Promise.resolve();
    if (root) {
      requestAnimationFrame(() => root.classList.add('is-morphing-to-main'));
    }
    await Promise.all([morphPromise, new Promise(r => setTimeout(r, 380))]);
    root?.remove();
    ob.open = false;
    ob.preview = false;
    ob.stage = 'model';
    ob.busy = false;
    ob.morphing = false;
    setTimeout(() => document.body.classList.remove('ob-revealing-main'), 480);
  }

  async function verifyAndContinue(connId, label, { activateBundled = null } = {}) {
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'testing';
    ob.statusText = `正在测试「${label || '模型'}」连通性…`;
    render();
    try {
      const test = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/test`, 'POST', {});
      await api('/api/model-settings/active', 'POST', { id: connId });
      ob.phase = 'success';
      ob.statusText = `连接成功 · ${test.model}（${test.latencyMs}ms）`;
      render();
      if (ob.preview) {
        await new Promise(r => setTimeout(r, 320));
        if (activateBundled) {
          await morphToBotStage({ botId: 'preview-codex', botName: activateBundled === 'grok-build' ? 'Grok Build' : 'Codex', bundledId: activateBundled, preview: true });
        } else {
          await transitionToMainNewGroup({ preview: true });
        }
        return;
      }
      const started = await api('/api/onboarding/start', 'POST', activateBundled ? { activateBundled } : {});
      if (started?.status === 'configuring_bot' && started.botId) {
        await morphToBotStage({
          botId: started.botId,
          botName: started.botName || started.activatedBot?.name,
          bundledId: started.bundledId || activateBundled,
          roomId: started.roomId || SUMMON_ROOM_ID,
          wakeMessageId: started.wakeMessageId || null,
        });
      } else {
        await transitionToMainNewGroup({ preview: false });
      }
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '模型连通性检测未通过，请检查配置后重试。';
      render();
    }
  }

  async function handleImportLocal(kind) {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.busy = true;
    ob.phase = 'saving';
    ob.statusText = `正在导入本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 订阅…`;
    render();
    try {
      const res = await api('/api/model-settings/local/import', 'POST', { kind, activate: true });
      const connId = res.importedId || `${kind}-local`;
      const activateBundled = kind === 'codex' ? 'codex' : kind === 'grok' ? 'grok-build' : null;
      await verifyAndContinue(connId, `本机 ${kind === 'codex' ? 'Codex' : 'Grok'} 订阅`, { activateBundled });
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '导入本机登录失败';
      render();
    }
  }

  async function handleStartSubOAuth(kind = 'codex') {
    if (ob.busy) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    const subLabel = kind === 'grok' ? 'Grok' : 'Codex';
    const defaultModel = kind === 'grok' ? 'grok-4.7' : 'gpt-6.1-terra';
    ob.busy = true;
    ob.phase = 'oauth';
    ob.statusText = `正在创建 ${subLabel} 订阅连接并获取授权码…`;
    render();
    try {
      const saved = await api('/api/model-settings/connections', 'POST', {
        kind, name: `${subLabel} 订阅`, model: ob.draft.model || defaultModel,
      });
      const connId = saved.savedId || saved.connections?.find(c => c.kind === kind && c.authMode !== `${kind}-local`)?.id;
      if (!connId) throw new Error(`未能创建 ${subLabel} 订阅连接`);
      ob.oauthConnId = connId;
      ob.oauthState = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/login`, 'POST', {});
      ob.busy = false;
      ob.statusText = '请在浏览器中完成授权，授权完成后将自动衔接下一步…';
      render();
      void pollSubOAuth(connId, kind);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || `无法发起 ${subLabel} 授权`;
      render();
    }
  }

  async function pollSubOAuth(connId, kind = 'codex') {
    stopOAuthPoll();
    const api = ob.callbacks?.api;
    if (!api || !ob.open || ob.oauthConnId !== connId) return;
    const subLabel = kind === 'grok' ? 'Grok' : 'Codex';
    try {
      const status = await api(`/api/model-settings/connections/${encodeURIComponent(connId)}/login`);
      ob.oauthState = status;
      if (['starting', 'waiting'].includes(status.status)) {
        render();
        ob.oauthTimer = setTimeout(() => void pollSubOAuth(connId, kind), 2000);
        return;
      }
      if (status.status === 'completed') {
        const activateBundled = kind === 'codex' ? 'codex' : kind === 'grok' ? 'grok-build' : null;
        await verifyAndContinue(connId, `${subLabel} 订阅`, { activateBundled });
        return;
      }
      ob.phase = status.status === 'failed' ? 'error' : 'idle';
      ob.statusText = status.status === 'failed' ? (status.error || `${subLabel} 授权未完成，请重试。`) : '';
      render();
    } catch (error) {
      ob.phase = 'error';
      ob.statusText = error.message || '读取授权状态失败';
      render();
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
    render();
  }

  async function handleModelSubmit(form) {
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
    render();
    try {
      const saved = await api('/api/model-settings/connections', 'POST', {
        kind: 'api',
        name: def.id === 'openai-compatible' ? (model || '自定义 API') : def.name,
        provider: def.provider, api: apiProto, baseUrl, model, apiKey, allowNoKey, activate: true,
      });
      const connId = saved.savedId || saved.activeId || saved.connections?.at(-1)?.id;
      if (!connId) throw new Error('未能保存模型配置');
      await verifyAndContinue(connId, def.name);
    } catch (error) {
      ob.busy = false;
      ob.phase = 'error';
      ob.statusText = error.message || '模型配置保存失败';
      render();
    }
  }

  async function sendBotReply(text) {
    const clean = String(text || '').trim();
    if (!clean || ob.botSending) return;
    const api = ob.callbacks?.api;
    if (!api) return;
    ob.botSending = true;
    render();
    try {
      await api(`/api/rooms/${encodeURIComponent(ob.roomId)}/messages`, 'POST', {
        text: clean,
        ...(ob.botId ? { mentions: [{ kind: 'bot', id: ob.botId }] } : {}),
      });
      const input = document.querySelector('#ob-bot-reply-form input[name=text]');
      if (input) input.value = '';
      await pollBotStage();
    } catch (error) {
      ob.callbacks?.toast?.(error.message || '发送失败', true);
    } finally {
      ob.botSending = false;
      render();
    }
  }

  async function openOverlay({ stage = 'model', preview = false, onboarding = null } = {}) {
    if (ob.open && ob.stage === stage && ob.preview === preview) return;
    ob.open = true;
    ob.preview = preview;
    ob.stage = stage;
    ob.busy = false;
    ob.phase = 'idle';
    ob.statusText = '';
    if (window.SummonDesktop) {
      document.documentElement.classList.add('desktop-onboarding-window');
    }
    ensureOverlayElement();
    if (stage === 'bot') {
      await morphToBotStage({
        botId: onboarding?.botId || ob.botId,
        botName: onboarding?.botName || ob.botName,
        bundledId: onboarding?.bundledId || ob.bundledId,
        roomId: onboarding?.roomId || SUMMON_ROOM_ID,
        wakeMessageId: onboarding?.wakeMessageId || null,
        preview,
      });
      return;
    }
    render();
    await loadCatalogAndLocal();
    if (ob.open && ob.stage === 'model') render();
  }

  async function closePreview() {
    if (!ob.preview) return;
    await transitionToMainNewGroup({ preview: true });
  }

  function syncState(onboarding) {
    if (!isLocalMode()) {
      if (ob.open && !ob.preview) {
        stopOAuthPoll();
        stopBotWatchers();
        document.getElementById('summon-onboarding-root')?.remove();
        document.documentElement.classList.remove('desktop-onboarding-window');
        ob.open = false;
      }
      return;
    }
    if (ob.preview || ob.morphing || !onboarding) return;
    if (onboarding.status === 'awaiting_model' && !onboarding.hasActiveModel) {
      if (!ob.open || ob.stage !== 'model') void openOverlay({ stage: 'model', preview: false, onboarding });
      return;
    }
    if (onboarding.status === 'configuring_bot') {
      if (!ob.open || ob.stage !== 'bot') void openOverlay({ stage: 'bot', preview: false, onboarding });
      return;
    }
    if (ob.open && onboarding.status === 'completed') {
      void transitionToMainNewGroup({ preview: false });
    }
  }

  function notifyUpdate() {
    if (ob.open && ob.stage === 'bot' && !ob.preview) {
      void pollBotStage();
    }
  }

  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-ob-action]');
    if (!btn) return;
    const action = btn.dataset.obAction;
    if (action === 'pick-provider') return selectProvider(btn.dataset.provider);
    if (action === 'import-local') return void handleImportLocal(btn.dataset.kind);
    if (action === 'start-sub-oauth' || action === 'start-codex-oauth') return void handleStartSubOAuth(btn.dataset.kind || 'codex');
    if (action === 'cancel-oauth') return void handleCancelOAuth();
    if (action === 'close-preview') return void closePreview();
    if (action === 'preview-next') return void morphToBotStage({ botId: 'preview-codex', botName: 'Codex', bundledId: 'codex', preview: true });
    if (action === 'finish-to-main') return void transitionToMainNewGroup({ preview: ob.preview });
    if (action === 'reply-prompt-opt') return void sendBotReply(btn.dataset.label || '');
    if (action === 'open-secret-prompt') {
      const msg = ob.botMessages.find(m => m.id === btn.dataset.msgId);
      if (msg?.prompt && window.SummonSecretInput?.open) {
        window.SummonSecretInput.open({ roomId: ob.roomId, message: msg, prompt: msg.prompt });
      }
      return;
    }
    if (action === 'reply-exec-req') {
      const api = ob.callbacks?.api;
      if (!api) return;
      try {
        await api('/api/executions/input', 'POST', {
          target: { kind: 'session', id: btn.dataset.execId },
          kind: 'reply',
          ...(btn.dataset.reqId ? { request_id: btn.dataset.reqId } : {}),
          input: btn.dataset.val || '',
        });
        await pollBotStage();
      } catch (error) {
        ob.callbacks?.toast?.(error.message || '提交失败', true);
      }
    }
  });

  document.addEventListener('input', event => {
    const form = event.target.closest('#ob-model-form');
    if (!form || !event.target.name) return;
    ob.draft[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (event.target.name === 'allowNoKey') render();
  });

  document.addEventListener('submit', event => {
    if (event.target.id === 'ob-model-form') {
      event.preventDefault();
      void handleModelSubmit(event.target);
    } else if (event.target.id === 'ob-bot-reply-form') {
      event.preventDefault();
      const input = event.target.querySelector('input[name=text]');
      if (input) void sendBotReply(input.value);
    }
  });

  window.SummonOnboarding = Object.freeze({
    bind(callbacks) { ob.callbacks = callbacks; },
    preopen(stage = 'model') { void openOverlay({ stage: stage === 'bot' ? 'bot' : 'model', preview: false }); },
    syncState,
    notifyUpdate,
    startPreview() { void openOverlay({ stage: 'model', preview: true }); },
    isActive: () => ob.open,
    SUMMON_ROOM_ID,
  });
})();
